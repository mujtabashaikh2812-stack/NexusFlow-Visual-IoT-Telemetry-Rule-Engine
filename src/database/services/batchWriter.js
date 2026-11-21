'use strict';

/**
 * Fast batch ingestion writer for TelemetryPoint readings.
 *
 *  - add(point) buffers a reading; nothing touches the database per reading.
 *  - A batch is written with bulkWrite([{ insertOne }...], { ordered: false })
 *    so one bad reading never blocks the others in the same batch.
 *  - Flush triggers: buffer reaches batchSize ("size"), the flush interval
 *    elapses ("interval"), flush() is called ("manual"), a retry after a failed
 *    write ("retry"), or close() ("shutdown").
 *  - If the database is unavailable, the whole batch goes back to the front of
 *    a bounded in-memory queue and is retried with exponential backoff. Data is
 *    never dropped silently: when the queue is full the OLDEST readings are
 *    dropped, counted in stats.dropped, logged, and handed to onDrop().
 *  - Readings the database itself rejects (duplicate key, schema rule) are
 *    permanent: they are counted in stats.failed and kept in a small
 *    dead-letter list (getDeadLetters()), not retried forever.
 *  - close() flushes what is left. Whatever still cannot be written is reported
 *    (return value, stats.unflushed, onUnflushed()) and kept in the queue.
 *
 * The target is a MongoDB collection, an in-memory collection, a function that
 * returns one, or a DatabaseConnection. For a DatabaseConnection in 'reconnecting'
 * mode the writer waits (queues) instead of writing into the connection's
 * temporary in-memory handle, whose data is never copied back to MongoDB. In
 * 'memory' mode (MongoDB never reachable, standalone/CI) that in-memory store is
 * the destination, as it is for every other caller.
 *
 * Loading this file never touches the network and never starts a timer.
 */

const { COLLECTION_NAME, buildTelemetryDocument } = require('../models/TelemetryPoint');
const { computeBackoffDelay } = require('../dbConnection');

const DEFAULT_BATCH_OPTIONS = Object.freeze({
  batchSize: 500,
  flushIntervalMs: 1000,
  maxQueueSize: 50000,
  retryBaseDelayMs: 200,
  retryMaxDelayMs: 5000,
  shutdownAttempts: 3,
  shutdownRetryDelayMs: 200,
  maxDeadLetters: 100,
  validate: true
});

const FLUSH_REASONS = ['size', 'interval', 'manual', 'retry', 'shutdown'];

function envPositiveInt(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

function positiveInt(label, value) {
  if (!Number.isFinite(value) || value < 1 || Math.floor(value) !== value) {
    throw new RangeError(`${label} must be a positive whole number (got ${value})`);
  }
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Error text that is safe to log or return: connection strings and credentials are masked. */
function safeMessage(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return msg.replace(/mongodb(\+srv)?:\/\/[^\s'"]+/gi, 'mongodb$1://<hidden>');
}

/**
 * Per-document write errors from a bulkWrite failure or result, or null when
 * the failure is not about individual documents (network, server selection...).
 */
function extractWriteErrors(source) {
  if (!source) return null;
  let list = source.writeErrors;
  if (list === undefined && source.result) list = source.result.writeErrors;
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) list = [list];
  return list.map((e) => ({
    index: e.index,
    code: e.code,
    message: safeMessage(e.errmsg || e.message || 'write error')
  }));
}

class BatchWriter {
  constructor(target, options = {}) {
    if (!target) throw new TypeError('BatchWriter needs a collection, a function returning one, or a database connection');
    const pick = (explicit, fromEnv, dflt) => (explicit !== undefined ? explicit : fromEnv !== undefined ? fromEnv : dflt);
    const d = DEFAULT_BATCH_OPTIONS;

    this.options = {
      collectionName: options.collectionName || COLLECTION_NAME,
      batchSize: positiveInt('batchSize', pick(options.batchSize, envPositiveInt('TELEMETRY_BATCH_SIZE'), d.batchSize)),
      flushIntervalMs: positiveInt(
        'flushIntervalMs',
        pick(options.flushIntervalMs, envPositiveInt('TELEMETRY_FLUSH_INTERVAL_MS'), d.flushIntervalMs)
      ),
      maxQueueSize: positiveInt(
        'maxQueueSize',
        pick(options.maxQueueSize, envPositiveInt('TELEMETRY_MAX_QUEUE_SIZE'), d.maxQueueSize)
      ),
      retryBaseDelayMs: positiveInt('retryBaseDelayMs', pick(options.retryBaseDelayMs, undefined, d.retryBaseDelayMs)),
      retryMaxDelayMs: positiveInt('retryMaxDelayMs', pick(options.retryMaxDelayMs, undefined, d.retryMaxDelayMs)),
      shutdownAttempts: positiveInt('shutdownAttempts', pick(options.shutdownAttempts, undefined, d.shutdownAttempts)),
      shutdownRetryDelayMs: positiveInt(
        'shutdownRetryDelayMs',
        pick(options.shutdownRetryDelayMs, undefined, d.shutdownRetryDelayMs)
      ),
      maxDeadLetters: positiveInt('maxDeadLetters', pick(options.maxDeadLetters, undefined, d.maxDeadLetters)),
      validate: options.validate !== undefined ? Boolean(options.validate) : d.validate
    };
    if (this.options.maxQueueSize < this.options.batchSize) {
      throw new RangeError(`maxQueueSize (${this.options.maxQueueSize}) must be at least batchSize (${this.options.batchSize})`);
    }

    this._target = target;
    this._logger = options.logger || console;
    this._onDrop = typeof options.onDrop === 'function' ? options.onDrop : null;
    this._onUnflushed = typeof options.onUnflushed === 'function' ? options.onUnflushed : null;

    this._queue = [];
    this._inFlight = 0;
    this._deadLetters = [];
    this._active = null;
    this._interval = null;
    this._retryTimer = null;
    this._closing = null;
    this._closed = false;
    this._consecutiveFailures = 0;
    this._lastDropWarnAt = 0;

    this._stats = {
      received: 0,
      written: 0,
      batches: 0,
      flushes: Object.fromEntries(FLUSH_REASONS.map((r) => [r, 0])),
      failedBatches: 0,
      retries: 0,
      requeued: 0,
      rejected: 0,
      failed: 0,
      dropped: 0,
      unflushed: 0,
      peakQueued: 0,
      lastFlushAt: null,
      lastFlushMs: null,
      lastError: null
    };

    this._interval = setInterval(() => {
      if (this._queue.length > 0 && !this._retryTimer) this._run('interval', false).catch(() => {});
    }, this.options.flushIntervalMs);
    if (typeof this._interval.unref === 'function') this._interval.unref();
  }

  // ------------------------------------------------------------- logging

  _log(level, msg) {
    try {
      const fn = this._logger && (this._logger[level] || this._logger.log);
      if (fn) fn.call(this._logger, `[batchWriter] ${msg}`);
    } catch (e) {
      // logging must never break the writer
    }
  }

  // ------------------------------------------------------------- intake

  /**
   * Buffers one reading. Throws when the reading is invalid (counted in
   * stats.rejected) or the writer is closed. Returns true when buffered.
   */
  add(point) {
    if (this._closing) throw new Error('BatchWriter is closed; it no longer accepts readings');
    let doc = point;
    if (this.options.validate) {
      try {
        doc = buildTelemetryDocument(point);
      } catch (err) {
        this._stats.rejected++;
        throw err;
      }
    } else if (!doc || typeof doc !== 'object') {
      this._stats.rejected++;
      throw new TypeError('reading must be an object');
    }
    this._stats.received++;
    this._enqueue(doc);
    if (this._queue.length >= this.options.batchSize && !this._retryTimer) this._run('size', false).catch(() => {});
    return true;
  }

  /** Buffers many readings. Invalid ones are skipped, not thrown. Returns { accepted, rejected, errors }. */
  addMany(points) {
    if (!Array.isArray(points)) throw new TypeError('addMany needs an array');
    const result = { accepted: 0, rejected: 0, errors: [] };
    points.forEach((p, index) => {
      try {
        this.add(p);
        result.accepted++;
      } catch (err) {
        if (this._closing) throw err;
        result.rejected++;
        result.errors.push({ index, message: safeMessage(err) });
      }
    });
    return result;
  }

  _enqueue(doc) {
    this._queue.push(doc);
    this._trimQueue();
    if (this._queue.length > this._stats.peakQueued) this._stats.peakQueued = this._queue.length;
  }

  /**
   * Keeps the queue within maxQueueSize. When the database has been unavailable
   * long enough to fill it, the OLDEST readings are dropped, loudly: counted,
   * logged and passed to onDrop(). (A batch being written right now is not
   * counted; if its write fails it returns to the front and the trim runs again.)
   */
  _trimQueue() {
    const overflow = this._queue.length - this.options.maxQueueSize;
    if (overflow <= 0) return;
    const dropped = this._queue.splice(0, overflow);
    this._stats.dropped += dropped.length;
    this._warnDropped();
    if (this._onDrop) {
      try {
        this._onDrop(dropped);
      } catch (e) {
        // a faulty callback must not break intake
      }
    }
  }

  _warnDropped() {
    const now = Date.now();
    if (now - this._lastDropWarnAt >= 1000) {
      this._lastDropWarnAt = now;
      this._log('warn', `queue full (${this.options.maxQueueSize}); oldest readings are being dropped (${this._stats.dropped} so far)`);
    }
  }

  // ------------------------------------------------------------- flushing

  /** Writes everything buffered now (also while a retry is waiting). Resolves { written, failed, remaining }. */
  flush() {
    return this._run('manual', true);
  }

  _run(reason, force) {
    if (this._active) return force ? this._active.then(() => this._run(reason, true)) : this._active;
    const run = (async () => {
      try {
        return await this._drain(reason, force);
      } finally {
        this._active = null;
      }
    })();
    this._active = run;
    return run;
  }

  async _drain(reason, force) {
    const summary = { written: 0, failed: 0, remaining: 0 };
    const stopAt = reason === 'size' ? this.options.batchSize : 1;
    while (this._queue.length >= stopAt) {
      if (!force && this._retryTimer) break;
      const batch = this._queue.splice(0, this.options.batchSize);
      this._inFlight = batch.length;
      let outcome;
      try {
        outcome = await this._writeBatch(batch, reason);
      } finally {
        this._inFlight = 0;
      }
      summary.written += outcome.written;
      summary.failed += outcome.failed;
      if (!outcome.ok) break;
    }
    summary.remaining = this._queue.length;
    return summary;
  }

  _resolveCollection() {
    const t = this._target;
    if (typeof t === 'function') return t();
    if (typeof t.bulkWrite === 'function') return t;
    if (typeof t.collection === 'function') {
      if (t.mode === 'reconnecting') throw new Error('database is reconnecting');
      return t.collection(this.options.collectionName);
    }
    throw new TypeError('BatchWriter target must be a collection, a function or a database connection');
  }

  async _writeBatch(batch, reason) {
    const started = Date.now();
    if (reason === 'retry') this._stats.retries++;
    let writeErrors = null;
    let inserted = batch.length;
    try {
      const collection = this._resolveCollection();
      const operations = batch.map((document) => ({ insertOne: { document } }));
      const result = await collection.bulkWrite(operations, { ordered: false });
      writeErrors = extractWriteErrors(result);
      if (writeErrors && writeErrors.length === 0) writeErrors = null;
    } catch (err) {
      writeErrors = extractWriteErrors(err);
      if (!writeErrors) {
        // Not about individual readings (database down, timeout...): keep everything and retry later.
        this._requeue(batch, err);
        return { ok: false, written: 0, failed: 0 };
      }
    }

    const failedIndexes = new Set();
    for (const we of writeErrors || []) {
      if (we.index === undefined || we.index < 0 || we.index >= batch.length || failedIndexes.has(we.index)) continue;
      failedIndexes.add(we.index);
      this._deadLetter(batch[we.index], we);
    }
    inserted = batch.length - failedIndexes.size;

    this._stats.written += inserted;
    this._stats.failed += failedIndexes.size;
    this._stats.batches++;
    this._stats.flushes[reason]++;
    this._stats.lastFlushAt = new Date();
    this._stats.lastFlushMs = Date.now() - started;
    if (this._consecutiveFailures > 0) {
      this._log('info', `database accepted writes again after ${this._consecutiveFailures} failed attempt(s)`);
    }
    this._consecutiveFailures = 0;
    this._clearRetryTimer();
    if (failedIndexes.size > 0) {
      this._log('warn', `${failedIndexes.size} reading(s) were rejected by the database and set aside (first: ${writeErrors[0].message})`);
    }
    return { ok: true, written: inserted, failed: failedIndexes.size };
  }

  _deadLetter(point, writeError) {
    this._deadLetters.push({ point, code: writeError.code, message: writeError.message });
    if (this._deadLetters.length > this.options.maxDeadLetters) this._deadLetters.shift();
  }

  _requeue(batch, err) {
    this._queue = batch.concat(this._queue);
    this._trimQueue();
    this._stats.failedBatches++;
    this._stats.requeued += batch.length;
    this._stats.lastError = safeMessage(err);
    this._consecutiveFailures++;
    const delay = computeBackoffDelay(this._consecutiveFailures - 1, {
      baseDelayMs: this.options.retryBaseDelayMs,
      maxDelayMs: this.options.retryMaxDelayMs
    });
    if (this._consecutiveFailures === 1) {
      this._log('warn', `write failed, ${batch.length} reading(s) kept in memory and retried (${this._stats.lastError})`);
    }
    if (!this._closing) this._scheduleRetry(delay);
  }

  _scheduleRetry(delay) {
    if (this._retryTimer) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._run('retry', false).catch(() => {});
    }, delay);
    if (typeof this._retryTimer.unref === 'function') this._retryTimer.unref();
  }

  _clearRetryTimer() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
  }

  // ------------------------------------------------------------- shutdown

  /**
   * Stops intake and timers, then writes what is left (a few attempts if the
   * database is down). Resolves { flushed, remaining }. Readings that still
   * could not be written stay in the queue (getQueuedPoints()) and are passed
   * to onUnflushed(). Safe to call more than once.
   */
  close() {
    if (this._closing) return this._closing;
    this._closing = (async () => {
      clearInterval(this._interval);
      this._clearRetryTimer();
      if (this._active) await this._active.catch(() => {});
      let flushed = 0;
      for (let attempt = 1; attempt <= this.options.shutdownAttempts; attempt++) {
        const r = await this._run('shutdown', true);
        flushed += r.written;
        if (this._queue.length === 0) break;
        if (attempt < this.options.shutdownAttempts) await sleep(this.options.shutdownRetryDelayMs);
      }
      this._closed = true;
      const remaining = this._queue.length;
      this._stats.unflushed = remaining;
      if (remaining > 0) {
        this._log('error', `closed with ${remaining} reading(s) NOT written to the database`);
        if (this._onUnflushed) {
          try {
            this._onUnflushed(this._queue.slice());
          } catch (e) {
            // a faulty callback must not break shutdown
          }
        }
      }
      return { flushed, remaining };
    })();
    return this._closing;
  }

  // ------------------------------------------------------------- reporting

  getStats() {
    const s = this._stats;
    return {
      received: s.received,
      written: s.written,
      batches: s.batches,
      flushes: { ...s.flushes },
      failedBatches: s.failedBatches,
      retries: s.retries,
      requeued: s.requeued,
      rejected: s.rejected,
      failed: s.failed,
      dropped: s.dropped,
      unflushed: s.unflushed,
      queued: this._queue.length + this._inFlight,
      peakQueued: s.peakQueued,
      deadLetters: this._deadLetters.length,
      backingOff: this._retryTimer !== null,
      closed: this._closed,
      lastFlushAt: s.lastFlushAt,
      lastFlushMs: s.lastFlushMs,
      lastError: s.lastError
    };
  }

  /** Readings the database rejected for good: [{ point, code, message }] (most recent maxDeadLetters). */
  getDeadLetters() {
    return this._deadLetters.map((d) => ({ ...d }));
  }

  /** Copy of the readings still waiting to be written. */
  getQueuedPoints() {
    return this._queue.slice();
  }
}

/**
 * Flushes a writer when the process is asked to stop (SIGINT, SIGTERM) or runs
 * out of work (beforeExit). It never calls process.exit: after the flush a
 * signal is sent again so the default behaviour (exit) still happens. Returns a
 * function that removes the hooks.
 */
function registerShutdownHooks(writer, options = {}) {
  const proc = options.processRef || process;
  const signals = options.signals || ['SIGINT', 'SIGTERM'];
  const handlers = [];

  const onSignal = (signal) => async () => {
    remove();
    try {
      await writer.close();
    } catch (err) {
      // close() reports its own problems; the process must still stop
    }
    if (typeof proc.kill === 'function') proc.kill(proc.pid, signal);
  };
  const onBeforeExit = () => {
    writer.close().catch(() => {});
  };

  function remove() {
    for (const [event, fn] of handlers) proc.removeListener(event, fn);
    handlers.length = 0;
  }

  for (const signal of signals) {
    const fn = onSignal(signal);
    proc.on(signal, fn);
    handlers.push([signal, fn]);
  }
  proc.on('beforeExit', onBeforeExit);
  handlers.push(['beforeExit', onBeforeExit]);
  return remove;
}

module.exports = {
  BatchWriter,
  registerShutdownHooks,
  extractWriteErrors,
  DEFAULT_BATCH_OPTIONS
};
