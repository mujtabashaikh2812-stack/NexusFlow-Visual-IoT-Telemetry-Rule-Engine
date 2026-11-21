'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const mongoose = require('mongoose');

const { BatchWriter, registerShutdownHooks, extractWriteErrors, DEFAULT_BATCH_OPTIONS } = require('../src/database/services/batchWriter');
const { COLLECTION_NAME, getTelemetryPointModel } = require('../src/database/models/TelemetryPoint');
const { DatabaseConnection } = require('../src/database/dbConnection');
const { InMemoryStore } = require('../src/database/inMemoryMock');
const { startRealMongo } = require('./helpers.realMongo');

const quiet = { info() {}, warn() {}, error() {}, log() {} };

function makeLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
    log: (m) => lines.info.push(String(m))
  };
}

let seq = 0;
const reading = (over = {}) => ({
  timestamp: new Date(Date.UTC(2026, 10, 14, 10, 0, seq++)),
  metadata: { deviceId: 'turbine-01', sensorType: 'temperature' },
  value: 20 + (seq % 10),
  unit: 'C',
  ...over
});

const writer = (target, over = {}) =>
  new BatchWriter(target, { flushIntervalMs: 60000, retryBaseDelayMs: 5, retryMaxDelayMs: 20, shutdownRetryDelayMs: 5, logger: quiet, ...over });

/** Polls until fn() is true (no fixed sleeps in the assertions). */
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

/** A collection whose bulkWrite can be told to fail, wrapping a real in-memory collection. */
function flakyCollection() {
  const inner = new InMemoryStore().collection(COLLECTION_NAME);
  const col = {
    inner,
    down: false,
    calls: [],
    async bulkWrite(ops, options) {
      col.calls.push({ size: ops.length, options });
      if (col.down) throw new Error('simulated: connection to mongodb://user:secret@db.example:27017 lost');
      return inner.bulkWrite(ops, options);
    }
  };
  return col;
}

test('defaults are sensible and frozen', () => {
  assert.equal(DEFAULT_BATCH_OPTIONS.batchSize, 500);
  assert.equal(DEFAULT_BATCH_OPTIONS.flushIntervalMs, 1000);
  assert.ok(DEFAULT_BATCH_OPTIONS.maxQueueSize >= DEFAULT_BATCH_OPTIONS.batchSize);
  assert.ok(Object.isFrozen(DEFAULT_BATCH_OPTIONS));
});

test('flushes by size: a full batch is written with one unordered bulkWrite', async () => {
  const col = flakyCollection();
  const w = writer(col, { batchSize: 5 });
  try {
    for (let i = 0; i < 4; i++) w.add(reading());
    assert.equal(col.calls.length, 0); // below the batch size: nothing written yet
    w.add(reading());
    assert.ok(await waitFor(() => w.getStats().written === 5));
    assert.deepEqual(col.calls, [{ size: 5, options: { ordered: false } }]);
    assert.equal(await col.inner.countDocuments({}), 5);
    const s = w.getStats();
    assert.equal(s.flushes.size, 1);
    assert.equal(s.queued, 0);
    assert.equal(s.batches, 1);
  } finally {
    await w.close();
  }
});

test('flushes by interval: a partial batch is written after the interval', async () => {
  const col = flakyCollection();
  const w = writer(col, { batchSize: 100, flushIntervalMs: 30 });
  try {
    w.add(reading());
    w.add(reading());
    assert.equal(col.calls.length, 0);
    assert.ok(await waitFor(() => w.getStats().written === 2));
    assert.equal(w.getStats().flushes.interval >= 1, true);
    assert.equal(await col.inner.countDocuments({}), 2);
  } finally {
    await w.close();
  }
});

test('manual flush writes the partial batch and reports the result', async () => {
  const col = flakyCollection();
  const w = writer(col, { batchSize: 100 });
  try {
    w.addMany([reading(), reading(), reading()]);
    assert.deepEqual(await w.flush(), { written: 3, failed: 0, remaining: 0 });
    assert.equal(w.getStats().flushes.manual, 1);
    assert.deepEqual(await w.flush(), { written: 0, failed: 0, remaining: 0 }); // empty flush is harmless
  } finally {
    await w.close();
  }
});

test('a large burst is split into batchSize chunks and nothing is lost', async () => {
  const col = flakyCollection();
  const w = writer(col, { batchSize: 10 });
  try {
    for (let i = 0; i < 95; i++) w.add(reading());
    await w.flush();
    assert.equal(await col.inner.countDocuments({}), 95);
    assert.ok(col.calls.every((c) => c.size <= 10));
    const s = w.getStats();
    assert.equal(s.received, 95);
    assert.equal(s.written, 95);
    assert.equal(s.dropped + s.failed + s.rejected, 0);
  } finally {
    await w.close();
  }
});

test('invalid readings are rejected and counted, valid ones go through', async () => {
  const col = flakyCollection();
  const w = writer(col, { batchSize: 100 });
  try {
    assert.throws(() => w.add({ metadata: { deviceId: 'd1' }, value: 1 }), /sensorType/);
    assert.throws(() => w.add(reading({ value: Number.NaN })), /Cast to Number|finite/);
    const res = w.addMany([reading(), { nope: true }, reading()]);
    assert.equal(res.accepted, 2);
    assert.equal(res.rejected, 1);
    assert.equal(res.errors[0].index, 1);
    await w.flush();
    assert.equal(await col.inner.countDocuments({}), 2);
    assert.equal(w.getStats().rejected, 3);
  } finally {
    await w.close();
  }
});

test('options are validated and read from the environment', () => {
  assert.throws(() => new BatchWriter(null), TypeError);
  assert.throws(() => writer(flakyCollection(), { batchSize: 0 }), RangeError);
  assert.throws(() => writer(flakyCollection(), { flushIntervalMs: -5 }), RangeError);
  assert.throws(() => writer(flakyCollection(), { batchSize: 10, maxQueueSize: 5 }), RangeError);
  process.env.TELEMETRY_BATCH_SIZE = '7';
  process.env.TELEMETRY_FLUSH_INTERVAL_MS = '250';
  process.env.TELEMETRY_MAX_QUEUE_SIZE = '70';
  try {
    const w = new BatchWriter(flakyCollection(), { logger: quiet });
    assert.equal(w.options.batchSize, 7);
    assert.equal(w.options.flushIntervalMs, 250);
    assert.equal(w.options.maxQueueSize, 70);
    const explicit = new BatchWriter(flakyCollection(), { batchSize: 9, logger: quiet });
    assert.equal(explicit.options.batchSize, 9); // explicit option beats the environment
    return Promise.all([w.close(), explicit.close()]);
  } finally {
    delete process.env.TELEMETRY_BATCH_SIZE;
    delete process.env.TELEMETRY_FLUSH_INTERVAL_MS;
    delete process.env.TELEMETRY_MAX_QUEUE_SIZE;
  }
});

test('ordered:false in practice: the rejected readings are set aside, the rest are stored', async () => {
  const col = flakyCollection();
  const w = writer(col, { batchSize: 100, validate: false });
  try {
    w.add({ _id: 'same', timestamp: new Date(), metadata: { deviceId: 'a', sensorType: 't' }, value: 1 });
    w.add({ _id: 'same', timestamp: new Date(), metadata: { deviceId: 'a', sensorType: 't' }, value: 2 });
    w.add({ _id: 'other', timestamp: new Date(), metadata: { deviceId: 'a', sensorType: 't' }, value: 3 });
    assert.deepEqual(await w.flush(), { written: 2, failed: 1, remaining: 0 });
    assert.equal(await col.inner.countDocuments({}), 2);
    const s = w.getStats();
    assert.equal(s.failed, 1);
    assert.equal(s.deadLetters, 1);
    assert.equal(s.failedBatches, 0); // a rejected reading is not an outage
    const dead = w.getDeadLetters();
    assert.equal(dead[0].point.value, 2);
    assert.equal(dead[0].code, 11000);
  } finally {
    await w.close();
  }
});

test('extractWriteErrors reads driver-style errors and returns null for other failures', () => {
  assert.equal(extractWriteErrors(new Error('socket closed')), null);
  assert.equal(extractWriteErrors(null), null);
  const driverLike = { writeErrors: [{ index: 3, code: 11000, errmsg: 'dup' }] };
  assert.deepEqual(extractWriteErrors(driverLike), [{ index: 3, code: 11000, message: 'dup' }]);
  assert.deepEqual(extractWriteErrors({ result: { writeErrors: { index: 1, code: 2, message: 'bad' } } }), [
    { index: 1, code: 2, message: 'bad' }
  ]);
});

test('DB outage: readings are kept, retried with backoff and written when the database returns', async () => {
  const col = flakyCollection();
  col.down = true;
  const w = writer(col, { batchSize: 4 });
  try {
    for (let i = 0; i < 4; i++) w.add(reading());
    assert.ok(await waitFor(() => w.getStats().failedBatches >= 2)); // retries are happening
    let s = w.getStats();
    assert.equal(s.written, 0);
    assert.equal(s.queued, 4); // nothing lost
    assert.equal(s.backingOff, true);
    assert.ok(s.retries >= 1);
    assert.ok(!/secret/.test(s.lastError), 'credentials must be masked in lastError');

    col.down = false;
    assert.ok(await waitFor(() => w.getStats().written === 4));
    s = w.getStats();
    assert.equal(s.queued, 0);
    assert.equal(s.backingOff, false);
    assert.equal(await col.inner.countDocuments({}), 4);
    assert.equal(s.dropped, 0);
  } finally {
    await w.close();
  }
});

test('DB outage: order is preserved when the failed batch is retried ahead of newer readings', async () => {
  const col = flakyCollection();
  col.down = true;
  const w = writer(col, { batchSize: 3, maxQueueSize: 100 });
  try {
    w.addMany([reading({ value: 1 }), reading({ value: 2 }), reading({ value: 3 })]);
    assert.ok(await waitFor(() => w.getStats().failedBatches >= 1));
    w.addMany([reading({ value: 4 }), reading({ value: 5 })]);
    col.down = false;
    await w.flush();
    const docs = await col.inner.find({}).toArray();
    assert.deepEqual(docs.map((d) => d.value), [1, 2, 3, 4, 5]);
  } finally {
    await w.close();
  }
});

test('bounded queue: the oldest readings are dropped loudly, never silently', async () => {
  const col = flakyCollection();
  col.down = true;
  const logger = makeLogger();
  const dropped = [];
  const w = writer(col, { batchSize: 5, maxQueueSize: 10, logger, onDrop: (pts) => dropped.push(...pts) });
  try {
    for (let i = 1; i <= 25; i++) w.add(reading({ value: i }));
    assert.ok(await waitFor(() => w.getStats().failedBatches >= 1));
    const s = w.getStats();
    assert.ok(s.queued <= 10, `queue must stay bounded, got ${s.queued}`);
    assert.equal(s.dropped, 25 - s.queued);
    assert.equal(dropped.length, s.dropped);
    assert.ok(logger.lines.warn.some((l) => /queue full/.test(l)));
    // the newest readings survive
    col.down = false;
    await w.flush();
    const values = (await col.inner.find({}).toArray()).map((d) => d.value).sort((a, b) => a - b);
    assert.deepEqual(values, [16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    assert.equal(w.getStats().written + w.getStats().dropped, 25);
  } finally {
    await w.close();
  }
});

test('graceful shutdown: close() flushes the buffer and then refuses new readings', async () => {
  const col = flakyCollection();
  const w = writer(col, { batchSize: 100 });
  w.addMany([reading(), reading(), reading()]);
  const result = await w.close();
  assert.deepEqual(result, { flushed: 3, remaining: 0 });
  assert.equal(await col.inner.countDocuments({}), 3);
  assert.throws(() => w.add(reading()), /closed/);
  assert.equal(w.getStats().closed, true);
  assert.equal(await w.close() === await w.close(), true); // idempotent
});

test('graceful shutdown: readings the database still refuses are reported, not hidden', async () => {
  const col = flakyCollection();
  col.down = true;
  const logger = makeLogger();
  let handedOver = null;
  const w = writer(col, { batchSize: 100, logger, shutdownAttempts: 2, onUnflushed: (pts) => (handedOver = pts) });
  w.addMany([reading({ value: 1 }), reading({ value: 2 })]);
  const result = await w.close();
  assert.deepEqual(result, { flushed: 0, remaining: 2 });
  assert.equal(w.getStats().unflushed, 2);
  assert.equal(handedOver.length, 2);
  assert.equal(w.getQueuedPoints().length, 2);
  assert.ok(logger.lines.error.some((l) => /NOT written/.test(l)));
  assert.equal(col.calls.length, 2); // shutdownAttempts honoured
});

test('shutdown hooks flush on a signal, re-raise it, and can be removed', async () => {
  const col = flakyCollection();
  const w = writer(col, { batchSize: 100 });
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.kill = (pid, signal) => (proc.killed = { pid, signal });
  const remove = registerShutdownHooks(w, { processRef: proc });
  assert.equal(proc.listenerCount('SIGTERM'), 1);
  assert.equal(proc.listenerCount('beforeExit'), 1);

  w.addMany([reading(), reading()]);
  proc.emit('SIGTERM');
  assert.ok(await waitFor(() => proc.killed));
  assert.deepEqual(proc.killed, { pid: 4242, signal: 'SIGTERM' });
  assert.equal(await col.inner.countDocuments({}), 2);
  assert.equal(proc.listenerCount('SIGTERM'), 0); // hooks removed itself before re-raising
  remove(); // calling it again is harmless

  const w2 = writer(col, { batchSize: 100 });
  const proc2 = new EventEmitter();
  const remove2 = registerShutdownHooks(w2, { processRef: proc2 });
  remove2();
  assert.equal(proc2.listenerCount('SIGINT') + proc2.listenerCount('SIGTERM') + proc2.listenerCount('beforeExit'), 0);
  await w2.close();
});

test('beforeExit flushes what is left', async () => {
  const col = flakyCollection();
  const w = writer(col, { batchSize: 100 });
  const proc = new EventEmitter();
  registerShutdownHooks(w, { processRef: proc });
  w.add(reading());
  proc.emit('beforeExit');
  assert.ok(await waitFor(() => w.getStats().closed));
  assert.equal(await col.inner.countDocuments({}), 1);
});

test('works through a DatabaseConnection in fallback (memory) mode', async () => {
  const db = new DatabaseConnection({
    connectFn: async () => {
      throw new Error('simulated connect failure');
    },
    maxRetries: 0,
    logger: quiet
  });
  await db.connect();
  const w = writer(db, { batchSize: 3 });
  try {
    assert.equal(db.mode, 'memory');
    w.addMany([reading(), reading(), reading(), reading()]);
    await w.flush();
    assert.equal(await db.collection(COLLECTION_NAME).countDocuments({}), 4);
  } finally {
    await w.close();
    await db.close();
  }
});

test('DatabaseConnection reconnecting: readings wait in the writer, then reach MongoDB after recovery', async () => {
  const native = flakyCollection();
  const nativeDb = { collection: () => native };
  let calls = 0;
  const db = new DatabaseConnection({
    connectFn: async () => {
      calls++;
      if (calls === 2) throw new Error('still down');
      return { db: nativeDb };
    },
    maxRetries: 0,
    reconnect: { enabled: true, maxAttempts: 10, baseDelayMs: 60, maxDelayMs: 60 },
    logger: quiet
  });
  const w = writer(db, { batchSize: 100 });
  try {
    await db.connect();
    assert.equal(db.mode, 'mongodb');
    mongoose.connection.emit('disconnected');
    assert.equal(db.mode, 'reconnecting');

    w.addMany([reading(), reading(), reading()]);
    const during = await w.flush();
    assert.equal(during.written, 0);
    assert.equal(during.remaining, 3);
    // Nothing went into the connection's temporary in-memory handle.
    assert.equal(await db._memory.collection(COLLECTION_NAME).countDocuments({}), 0);
    assert.equal(native.calls.length, 0);

    assert.equal(await db.waitForRecovery(3000), true);
    assert.ok(await waitFor(() => w.getStats().written === 3)); // the retry timer delivers them
    assert.equal(await native.inner.countDocuments({}), 3);
    assert.equal(w.getStats().queued, 0);
  } finally {
    await w.close();
    await db.close();
  }
});

test('a function target is resolved on every write', async () => {
  const a = flakyCollection();
  const b = flakyCollection();
  let current = a;
  const w = writer(() => current, { batchSize: 100 });
  try {
    w.add(reading());
    await w.flush();
    current = b;
    w.add(reading());
    await w.flush();
    assert.equal(await a.inner.countDocuments({}), 1);
    assert.equal(await b.inner.countDocuments({}), 1);
  } finally {
    await w.close();
  }
});

test('real mongod: batched unordered writes land in the time-series collection, a bad reading does not block the batch', async (t) => {
  const started = await startRealMongo();
  if (started.skip) return t.skip(started.skip);
  const { server } = started;
  const conn = mongoose.createConnection(server.getUri('nexusflow_batch_test'));
  try {
    await conn.asPromise();
    await getTelemetryPointModel(conn).createCollection();
    const col = conn.db.collection(COLLECTION_NAME);
    const w = writer(col, { batchSize: 50, validate: false });

    for (let i = 0; i < 120; i++) w.add(reading({ value: i }));
    // One reading the time-series collection must refuse (no timestamp) in the middle of a batch.
    w.add({ metadata: { deviceId: 'bad', sensorType: 'temperature' }, value: 1 });
    for (let i = 120; i < 130; i++) w.add(reading({ value: i }));

    const result = await w.flush();
    assert.equal(result.failed, 1);
    assert.equal(result.remaining, 0);
    const s = w.getStats();
    assert.equal(s.written, 130);
    assert.equal(s.failed, 1);
    assert.equal(await col.countDocuments({}), 130);
    assert.equal(w.getDeadLetters().length, 1);
    await w.close();
  } finally {
    await conn.close();
    await server.stop();
  }
});

test('real mongod: a database that goes away mid-run loses nothing and catches up when it returns', async (t) => {
  const started = await startRealMongo();
  if (started.skip) return t.skip(started.skip);
  const { server } = started;
  const conn = mongoose.createConnection(server.getUri('nexusflow_batch_outage'));
  let w;
  try {
    await conn.asPromise();
    await getTelemetryPointModel(conn).createCollection();
    const col = conn.db.collection(COLLECTION_NAME);
    // Simulate the outage at the collection call so the test does not wait for server selection timeouts.
    let down = false;
    const gate = {
      bulkWrite: (ops, opts) => (down ? Promise.reject(new Error('simulated outage')) : col.bulkWrite(ops, opts))
    };
    w = writer(gate, { batchSize: 20 });
    for (let i = 0; i < 20; i++) w.add(reading());
    assert.ok(await waitFor(() => w.getStats().written === 20));
    down = true;
    for (let i = 0; i < 60; i++) w.add(reading());
    assert.ok(await waitFor(() => w.getStats().failedBatches >= 1));
    assert.equal(await col.countDocuments({}), 20);
    down = false;
    assert.ok(await waitFor(() => w.getStats().written === 80));
    assert.equal(await col.countDocuments({}), 80);
    assert.equal(w.getStats().dropped, 0);
  } finally {
    if (w) await w.close();
    await conn.close();
    await server.stop();
  }
});
