'use strict';

/**
 * Resilient MongoDB connection manager.
 *
 *  - connect(): retries with exponential backoff, then falls back to an
 *    in-memory store instead of crashing (zero-crash standalone mode).
 *  - Auto-reconnect: when a live connection drops, the manager switches to
 *    'reconnecting' (collection() keeps working through the in-memory store),
 *    retries with backoff and returns to 'mongodb' when the server is back.
 *  - Never calls process.exit.
 *
 * Modes: 'disconnected' | 'mongodb' | 'reconnecting' | 'memory'
 */

const { EventEmitter } = require('events');
const { InMemoryStore } = require('./inMemoryMock');

const DEFAULT_URI = 'mongodb://127.0.0.1:27017/nexusflow';

const DEFAULT_OPTIONS = {
  uri: DEFAULT_URI,
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
  allowMemoryFallback: true,
  reconnect: {
    enabled: true,
    maxAttempts: 10,
    baseDelayMs: 100,
    maxDelayMs: 5000
  }
};

/** baseDelayMs * 2^attempt, capped at maxDelayMs, never negative. Pure. */
function computeBackoffDelay(attempt, options = {}) {
  const base = Number.isFinite(options.baseDelayMs) ? options.baseDelayMs : DEFAULT_OPTIONS.baseDelayMs;
  const max = Number.isFinite(options.maxDelayMs) ? options.maxDelayMs : DEFAULT_OPTIONS.maxDelayMs;
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  let delay = base * Math.pow(2, n);
  if (!Number.isFinite(delay)) delay = max; // 2^n overflow (or 0 * Infinity)
  return Math.max(0, Math.min(delay, max));
}

/** Splits a MongoDB URI into scheme / host / database without ever returning credentials. */
function parseUri(uri) {
  const m = /^(mongodb(?:\+srv)?):\/\/(?:[^@/]*@)?([^/?]*)(?:\/([^?]*))?/i.exec(String(uri || ''));
  if (!m) return { scheme: null, host: null, database: null };
  return { scheme: m[1].toLowerCase(), host: m[2] || null, database: m[3] || null };
}

function isProductionUri(uri) {
  if (process.env.NODE_ENV === 'production') return true;
  const { scheme, host } = parseUri(uri);
  return scheme === 'mongodb+srv' || (host !== null && host.toLowerCase().includes('mongodb.net'));
}

/** Error text that is safe to log or return: connection strings and credentials are masked. */
function safeMessage(err, uri) {
  let msg = err && err.message ? String(err.message) : String(err);
  if (uri) msg = msg.split(String(uri)).join('<uri>');
  return msg.replace(/mongodb(\+srv)?:\/\/[^\s'"]+/gi, 'mongodb$1://<hidden>');
}

function envInt(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

const noopErrorSink = () => {};

/**
 * mongoose emits a deferred 'error' event after a failed connect attempt when an
 * 'error' listener existed at failure time. If close() removed ours in between,
 * that late event would be unhandled and crash the process, so a no-op sink stays.
 */
function keepErrorSink(conn) {
  if (conn && typeof conn.on === 'function' && !conn.listeners('error').includes(noopErrorSink)) {
    conn.on('error', noopErrorSink);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class DatabaseConnection {
  constructor(options = {}) {
    const userReconnect = options.reconnect || {};
    // Explicit options win, then environment variables, then defaults.
    const env = {
      uri: process.env.MONGODB_URI || undefined,
      maxRetries: envInt('DB_MAX_RETRIES'),
      baseDelayMs: envInt('DB_BASE_DELAY_MS'),
      maxDelayMs: envInt('DB_MAX_DELAY_MS'),
      reconnectMaxAttempts: envInt('DB_RECONNECT_MAX_ATTEMPTS')
    };
    const pick = (explicit, fromEnv, dflt) => (explicit !== undefined ? explicit : fromEnv !== undefined ? fromEnv : dflt);

    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      uri: pick(options.uri, env.uri, DEFAULT_OPTIONS.uri),
      maxRetries: pick(options.maxRetries, env.maxRetries, DEFAULT_OPTIONS.maxRetries),
      baseDelayMs: pick(options.baseDelayMs, env.baseDelayMs, DEFAULT_OPTIONS.baseDelayMs),
      maxDelayMs: pick(options.maxDelayMs, env.maxDelayMs, DEFAULT_OPTIONS.maxDelayMs),
      allowMemoryFallback: pick(options.allowMemoryFallback, undefined, DEFAULT_OPTIONS.allowMemoryFallback),
      reconnect: {
        ...DEFAULT_OPTIONS.reconnect,
        ...userReconnect,
        maxAttempts: pick(userReconnect.maxAttempts, env.reconnectMaxAttempts, DEFAULT_OPTIONS.reconnect.maxAttempts)
      }
    };
    delete this.options.connectFn;
    delete this.options.logger;

    this._logger = options.logger || console;

    // Lazy, guarded load: a missing mongoose module must never crash the process.
    this._mongoose = null;
    try {
      this._mongoose = require('mongoose');
    } catch (err) {
      this._mongoose = null;
    }

    this._connectFn = options.connectFn || ((uri) => {
      if (!this._mongoose) throw new Error('mongoose module is not available');
      return this._mongoose.connect(uri, {
        serverSelectionTimeoutMS: this.options.serverSelectionTimeoutMS || 5000
      });
    });

    this._memory = new InMemoryStore();
    this._nativeDb = null;
    this._mode = 'disconnected';
    this._closed = false;

    this._listenersRegistered = false;
    this._onDisconnected = () => this._handleConnectionLoss('connection disconnected');
    this._onError = (err) => this._handleConnectionLoss(err);

    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._pendingTimers = 0;
    this._peakPendingTimers = 0;

    this._events = new EventEmitter();
    this._stats = {
      attempts: 0,
      reconnects: 0,
      lastError: null,
      connectedAt: null,
      nextRetryDelayMs: null
    };
  }

  get mode() {
    return this._mode;
  }

  _setMode(mode) {
    this._mode = mode;
    this._events.emit('mode', mode);
  }

  _log(level, msg) {
    try {
      const fn = this._logger && (this._logger[level] || this._logger.log);
      if (fn) fn.call(this._logger, msg);
    } catch (e) {
      // logging must never break the connection manager
    }
  }

  _recordError(err) {
    this._stats.lastError = safeMessage(err, this.options.uri);
  }

  /** Runs one connection attempt and captures the native db handle. */
  async _attemptConnect() {
    const result = await this._connectFn(this.options.uri);
    this._nativeDb =
      (result && result.connection && result.connection.db) ||
      (result && result.db) ||
      (this._mongoose && this._mongoose.connection && this._mongoose.connection.db) ||
      null;
  }

  _registerListeners() {
    if (this._listenersRegistered || !this._mongoose || !this._mongoose.connection) return;
    this._mongoose.connection.on('disconnected', this._onDisconnected);
    this._mongoose.connection.on('error', this._onError);
    this._listenersRegistered = true;
  }

  _removeListeners() {
    if (!this._listenersRegistered) return;
    try {
      this._mongoose.connection.removeListener('disconnected', this._onDisconnected);
      this._mongoose.connection.removeListener('error', this._onError);
      keepErrorSink(this._mongoose.connection);
    } catch (e) {
      // ignore
    }
    this._listenersRegistered = false;
  }

  /**
   * Tries up to maxRetries + 1 times with exponential backoff between attempts.
   * Resolves with the final mode; throws only when allowMemoryFallback is false.
   */
  async connect() {
    this._closed = false;
    this._clearReconnectTimer();
    const total = this.options.maxRetries + 1;
    let lastErr = null;

    for (let attempt = 0; attempt < total; attempt++) {
      if (this._closed) return this._mode;
      this._stats.attempts++;
      try {
        await this._attemptConnect();
        if (this._closed) return this._mode;
        this._stats.connectedAt = new Date().toISOString();
        this._stats.lastError = null;
        this._reconnectAttempt = 0;
        this._registerListeners();
        this._setMode('mongodb');
        this._log('info', `[db] connected (attempt ${attempt + 1}/${total})`);
        return this._mode;
      } catch (err) {
        lastErr = err;
        this._recordError(err);
        if (attempt < total - 1) {
          const delay = computeBackoffDelay(attempt, this.options);
          this._log('warn', `[db] attempt ${attempt + 1}/${total} failed: ${this._stats.lastError}; retrying in ${delay}ms`);
          await sleep(delay);
        } else {
          this._log('warn', `[db] attempt ${attempt + 1}/${total} failed: ${this._stats.lastError}`);
        }
      }
    }

    if (this.options.allowMemoryFallback) {
      this._nativeDb = null;
      this._setMode('memory');
      this._log('warn', `[db] MongoDB unreachable after ${total} attempts - using in-memory fallback (data is not persisted)`);
      return this._mode;
    }
    this._setMode('disconnected');
    const error = new Error(`MongoDB connection failed after ${total} attempts: ${safeMessage(lastErr, this.options.uri)}`);
    throw error;
  }

  // ------------------------------------------------------ auto-reconnect

  /** Called when the live connection drops (mongoose 'disconnected' / 'error' events). */
  _handleConnectionLoss(reason) {
    if (this._mode !== 'mongodb' || this._closed) return; // already recovering, never connected, or closed
    this._recordError(reason);
    this._nativeDb = null;
    if (!this.options.reconnect.enabled) {
      if (this.options.allowMemoryFallback) {
        this._setMode('memory');
        this._log('warn', '[db] connection lost and reconnect is disabled - using in-memory fallback');
      } else {
        this._setMode('disconnected');
        this._log('error', '[db] connection lost and reconnect is disabled');
      }
      return;
    }
    this._setMode('reconnecting');
    this._reconnectAttempt = 0;
    this._log('warn', `[db] connection lost (${this._stats.lastError}) - reconnecting`);
    this._scheduleReconnect();
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this._pendingTimers--;
    }
    this._stats.nextRetryDelayMs = null;
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this._mode !== 'reconnecting' || this._closed) return; // only one timer at a time
    const delay = computeBackoffDelay(this._reconnectAttempt, this.options.reconnect);
    this._stats.nextRetryDelayMs = delay;
    this._pendingTimers++;
    this._peakPendingTimers = Math.max(this._peakPendingTimers, this._pendingTimers);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._pendingTimers--;
      this._stats.nextRetryDelayMs = null;
      this._runReconnectAttempt();
    }, delay);
  }

  async _runReconnectAttempt() {
    if (this._mode !== 'reconnecting' || this._closed) return;
    const max = this.options.reconnect.maxAttempts;
    const attemptNo = this._reconnectAttempt + 1;
    try {
      await this._attemptConnect();
      if (this._closed || this._mode !== 'reconnecting') return;
      this._stats.reconnects++;
      this._stats.connectedAt = new Date().toISOString();
      this._stats.lastError = null;
      this._reconnectAttempt = 0;
      this._registerListeners();
      this._setMode('mongodb');
      this._log('info', `[db] reconnected to MongoDB (reconnect attempt ${attemptNo}/${max})`);
    } catch (err) {
      if (this._closed || this._mode !== 'reconnecting') return;
      this._recordError(err);
      this._reconnectAttempt++;
      if (this._reconnectAttempt < max) {
        this._scheduleReconnect();
        return;
      }
      if (this.options.allowMemoryFallback) {
        this._setMode('memory');
        this._log('warn', `[db] reconnect failed after ${max} attempts - settling into in-memory fallback (data is not persisted)`);
      } else {
        this._setMode('disconnected');
        this._log('error', `[db] reconnect failed after ${max} attempts - giving up (last error: ${this._stats.lastError})`);
      }
    }
  }

  // ------------------------------------------------------------- public

  collection(name) {
    if (this._mode === 'mongodb' && this._nativeDb) return this._nativeDb.collection(name);
    if (this._mode === 'mongodb' || this._mode === 'memory' || this._mode === 'reconnecting') {
      return this._memory.collection(name);
    }
    throw new Error('Database is not connected (call connect() first)');
  }

  getStats() {
    const { host, database } = parseUri(this.options.uri);
    return {
      mode: this._mode,
      fallback: this._mode === 'memory',
      attempts: this._stats.attempts,
      reconnects: this._stats.reconnects,
      host,
      database,
      isProductionUri: isProductionUri(this.options.uri),
      lastError: this._stats.lastError,
      connectedAt: this._stats.connectedAt,
      nextRetryDelayMs: this._stats.nextRetryDelayMs
    };
  }

  /**
   * Resolves true when the mode is 'mongodb'. Resolves false on timeout, or as
   * soon as recovery has given up (mode 'memory' or 'disconnected').
   */
  waitForRecovery(timeoutMs = 5000) {
    if (this._mode === 'mongodb') return Promise.resolve(true);
    if (this._mode !== 'reconnecting') return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer);
        this._events.removeListener('mode', onMode);
        resolve(value);
      };
      const onMode = (mode) => {
        if (mode === 'mongodb') finish(true);
        else if (mode !== 'reconnecting') finish(false);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this._events.on('mode', onMode);
    });
  }

  async close() {
    this._closed = true;
    this._clearReconnectTimer();
    this._removeListeners();
    this._nativeDb = null;
    try {
      const conn = this._mongoose && this._mongoose.connection;
      if (conn && conn.readyState !== 0) await conn.close();
    } catch (err) {
      this._recordError(err);
    }
    this._setMode('disconnected');
  }
}

let instance = null;

/** Singleton accessor: reuses the existing instance unless options are passed. */
function getDatabase(options) {
  if (options !== undefined || !instance) {
    if (instance) instance.close().catch(() => {});
    instance = new DatabaseConnection(options || {});
  }
  return instance;
}

module.exports = {
  DatabaseConnection,
  getDatabase,
  computeBackoffDelay,
  isProductionUri,
  DEFAULT_URI,
  DEFAULT_OPTIONS
};
