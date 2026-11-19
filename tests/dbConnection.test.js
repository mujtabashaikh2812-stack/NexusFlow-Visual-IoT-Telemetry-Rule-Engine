'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const {
  DatabaseConnection,
  getDatabase,
  computeBackoffDelay,
  isProductionUri,
  DEFAULT_URI,
  DEFAULT_OPTIONS
} = require('../src/database/dbConnection');
const { InMemoryStore } = require('../src/database/inMemoryMock');

const UNREACHABLE = 'mongodb://127.0.0.1:27099/nexusflow';

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

/** connectFn that follows a script: 'ok' resolves, anything else rejects. */
function scriptedConnect(script) {
  const calls = [];
  const fn = async () => {
    const step = script[Math.min(calls.length, script.length - 1)];
    calls.push(step);
    if (step === 'ok') return { db: null };
    throw new Error('simulated connect failure');
  };
  fn.calls = calls;
  return fn;
}

function withNodeEnv(value, fn) {
  const prev = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
}

// ---------------------------------------------------------------- 1
test('computeBackoffDelay doubles from the base and caps at maxDelayMs', () => {
  const opts = { baseDelayMs: 100, maxDelayMs: 2000 };
  assert.deepEqual([0, 1, 2, 3, 4].map((a) => computeBackoffDelay(a, opts)), [100, 200, 400, 800, 1600]);
  assert.equal(computeBackoffDelay(5, opts), 2000);
  assert.equal(computeBackoffDelay(50, opts), 2000);
  assert.equal(computeBackoffDelay(5000, opts), 2000); // 2^5000 overflows to Infinity
  assert.equal(computeBackoffDelay(-3, opts), 100);
  assert.ok(computeBackoffDelay(2, { baseDelayMs: -50, maxDelayMs: 2000 }) >= 0);
  assert.equal(DEFAULT_URI, 'mongodb://127.0.0.1:27017/nexusflow');
  assert.equal(DEFAULT_OPTIONS.reconnect.maxAttempts, 10);
});

// ---------------------------------------------------------------- 2
test('isProductionUri recognises srv, mongodb.net and NODE_ENV=production', () => {
  withNodeEnv('development', () => {
    assert.equal(isProductionUri('mongodb+srv://user:pw@cluster0.abc.mongodb.net/app'), true);
    assert.equal(isProductionUri('mongodb://user:pw@shard-00.abc.mongodb.net:27017/app'), true);
    assert.equal(isProductionUri('mongodb://127.0.0.1:27017/nexusflow'), false);
  });
  withNodeEnv('production', () => {
    assert.equal(isProductionUri('mongodb://127.0.0.1:27017/nexusflow'), true);
  });
});

// ---------------------------------------------------------------- 3
test('connect() falls back to memory for an unreachable URI and the store accepts writes', async () => {
  const logger = makeLogger();
  const db = new DatabaseConnection({
    uri: UNREACHABLE,
    maxRetries: 1,
    baseDelayMs: 1,
    maxDelayMs: 5,
    serverSelectionTimeoutMS: 300,
    logger
  });
  try {
    await db.connect();
    assert.equal(db.getStats().mode, 'memory');
    assert.equal(db.getStats().attempts, 2);
    const fallbackWarnings = logger.lines.warn.filter((l) => /fallback/i.test(l));
    assert.equal(fallbackWarnings.length, 1);

    const col = db.collection('readings');
    await col.insertOne({ deviceId: 'pump-01', value: 1 });
    assert.equal(await col.countDocuments({ deviceId: 'pump-01' }), 1);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------- 4
test('connect() throws when fallback is disabled and the URI is unreachable', async () => {
  const db = new DatabaseConnection({
    uri: UNREACHABLE,
    maxRetries: 1,
    baseDelayMs: 1,
    maxDelayMs: 5,
    allowMemoryFallback: false,
    serverSelectionTimeoutMS: 300,
    logger: makeLogger()
  });
  try {
    await assert.rejects(() => db.connect(), /connection failed/i);
    assert.equal(db.getStats().mode, 'disconnected');
    assert.throws(() => db.collection('x'), /not connected/i);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------- 5
test('a missing mongoose module cannot crash the process', async () => {
  const realLoad = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === 'mongoose') {
      const err = new Error("Cannot find module 'mongoose'");
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return realLoad.call(this, request, ...rest);
  };
  let db;
  try {
    db = new DatabaseConnection({ uri: UNREACHABLE, maxRetries: 1, baseDelayMs: 1, logger: makeLogger() });
  } finally {
    Module._load = realLoad;
  }
  assert.equal(db._mongoose, null);
  await db.connect(); // default connectFn throws "mongoose module is not available" -> fallback
  assert.equal(db.getStats().mode, 'memory');
  assert.match(db.getStats().lastError, /mongoose/);
  await db.collection('c').insertOne({ a: 1 });
  await db.close();
});

test('a connectFn that throws synchronously also falls back without crashing', async () => {
  const db = new DatabaseConnection({
    maxRetries: 1,
    baseDelayMs: 1,
    logger: makeLogger(),
    connectFn: () => {
      throw new Error('boom');
    }
  });
  await db.connect();
  assert.equal(db.getStats().mode, 'memory');
  await db.close();
});

// ---------------------------------------------------------------- 6
test('AUTO-RECONNECT: drops to reconnecting, keeps a working handle, then recovers', async () => {
  const logger = makeLogger();
  const connectFn = scriptedConnect(['ok', 'fail', 'fail', 'ok']);
  const db = new DatabaseConnection({
    connectFn,
    logger,
    maxRetries: 0,
    reconnect: { enabled: true, maxAttempts: 10, baseDelayMs: 10, maxDelayMs: 40 }
  });
  try {
    await db.connect();
    assert.equal(db.getStats().mode, 'mongodb');

    // Simulate the live connection dropping through the real mongoose event path.
    const mongoose = require('mongoose');
    mongoose.connection.emit('disconnected');
    assert.equal(db.getStats().mode, 'reconnecting');
    assert.equal(db.getStats().nextRetryDelayMs, 10);

    // collection() must keep working during the recovery window.
    const col = db.collection('readings');
    await col.insertOne({ deviceId: 'pump-01' });
    assert.equal(await col.countDocuments({}), 1);

    assert.equal(await db.waitForRecovery(3000), true);
    const stats = db.getStats();
    assert.equal(stats.mode, 'mongodb');
    assert.ok(stats.reconnects >= 1);
    assert.equal(connectFn.calls.length, 4); // 1 initial + 2 failed + 1 successful reconnect
    assert.equal(logger.lines.info.filter((l) => /reconnected/.test(l)).length, 1);
    assert.equal(db._peakPendingTimers, 1);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------- 7
test('AUTO-RECONNECT exhaustion: settles in memory, never throws, one timer at a time', async () => {
  const logger = makeLogger();
  const connectFn = scriptedConnect(['ok', 'fail']);
  const db = new DatabaseConnection({
    connectFn,
    logger,
    maxRetries: 0,
    reconnect: { enabled: true, maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 20 }
  });
  try {
    await db.connect();
    const mongoose = require('mongoose');
    // A burst of drop signals must not schedule more than one timer.
    mongoose.connection.emit('disconnected');
    mongoose.connection.emit('error', new Error('socket closed'));
    mongoose.connection.emit('disconnected');
    assert.equal(db.getStats().mode, 'reconnecting');
    assert.equal(db._pendingTimers, 1);

    assert.equal(await db.waitForRecovery(3000), false); // gave up, did not time out
    const stats = db.getStats();
    assert.equal(stats.mode, 'memory');
    assert.equal(stats.reconnects, 0);
    assert.equal(connectFn.calls.length, 1 + 3); // initial + maxAttempts
    assert.equal(db._peakPendingTimers, 1);
    assert.equal(db._pendingTimers, 0);
    assert.equal(logger.lines.warn.filter((l) => /fallback/.test(l)).length, 1);
    await db.collection('c').insertOne({ ok: true }); // still usable
  } finally {
    await db.close();
  }
});

test('AUTO-RECONNECT exhaustion with fallback disabled records the error and stops', async () => {
  const connectFn = scriptedConnect(['ok', 'fail']);
  const db = new DatabaseConnection({
    connectFn,
    logger: makeLogger(),
    maxRetries: 0,
    allowMemoryFallback: false,
    reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 10 }
  });
  try {
    await db.connect();
    db._handleConnectionLoss(new Error('lost'));
    assert.equal(await db.waitForRecovery(3000), false);
    assert.equal(db.getStats().mode, 'disconnected');
    assert.match(db.getStats().lastError, /simulated connect failure/);
    const callsAtStop = connectFn.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(connectFn.calls.length, callsAtStop); // really stopped retrying
  } finally {
    await db.close();
  }
});

test('close() clears a pending reconnect timer', async () => {
  const connectFn = scriptedConnect(['ok', 'fail']);
  const db = new DatabaseConnection({
    connectFn,
    logger: makeLogger(),
    maxRetries: 0,
    reconnect: { enabled: true, maxAttempts: 5, baseDelayMs: 50, maxDelayMs: 100 }
  });
  await db.connect();
  db._handleConnectionLoss(new Error('lost'));
  assert.equal(db._pendingTimers, 1);
  await db.close();
  assert.equal(db._pendingTimers, 0);
  assert.equal(db.getStats().mode, 'disconnected');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(connectFn.calls.length, 1); // the timer never fired
});

test('a late mongoose error after close() does not crash the process', async () => {
  const db = new DatabaseConnection({ connectFn: scriptedConnect(['ok']), logger: makeLogger(), maxRetries: 0 });
  await db.connect();
  await db.close();
  const mongoose = require('mongoose');
  assert.doesNotThrow(() => mongoose.connection.emit('error', new Error('late error from an in-flight attempt')));
});

// ---------------------------------------------------------------- 8
test('in-memory store: deep copies on read', async () => {
  const store = new InMemoryStore();
  const col = store.collection('t');
  await col.insertOne({ _id: 'a', meta: { deviceId: 'pump-01' }, tags: ['x'] });
  const got = await col.findOne({ _id: 'a' });
  got.meta.deviceId = 'HACKED';
  got.tags.push('y');
  const again = await col.findOne({ _id: 'a' });
  assert.equal(again.meta.deviceId, 'pump-01');
  assert.deepEqual(again.tags, ['x']);
  const list = await col.find({}).toArray();
  list[0].meta.deviceId = 'HACKED';
  assert.equal((await col.findOne({ _id: 'a' })).meta.deviceId, 'pump-01');
});

test('in-memory store: filters on dotted paths and operators, sort/skip/limit', async () => {
  const col = new InMemoryStore().collection('t');
  await col.insertMany([
    { metadata: { deviceId: 'p1' }, v: 1 },
    { metadata: { deviceId: 'p1' }, v: 5 },
    { metadata: { deviceId: 'p2' }, v: 9 },
    { metadata: { deviceId: 'p3' } }
  ]);
  assert.equal(await col.countDocuments({ 'metadata.deviceId': 'p1' }), 2);
  assert.equal(await col.countDocuments({ v: { $gt: 1 } }), 2);
  assert.equal(await col.countDocuments({ v: { $gte: 1, $lt: 9 } }), 2);
  assert.equal(await col.countDocuments({ v: { $lte: 5 } }), 2);
  assert.equal(await col.countDocuments({ 'metadata.deviceId': { $in: ['p1', 'p3'] } }), 3);
  assert.equal(await col.countDocuments({ 'metadata.deviceId': { $ne: 'p1' } }), 2);
  assert.equal(await col.countDocuments({ v: { $exists: true } }), 3);
  assert.equal(await col.countDocuments({ v: { $exists: false } }), 1);
  const top = await col.find({ v: { $exists: true } }).sort({ v: -1 }).skip(1).limit(1).toArray();
  assert.deepEqual(top.map((d) => d.v), [5]);
  await assert.rejects(() => col.find({ v: { $regex: 'x' } }).toArray(), /unsupported operator/);
});

test('in-memory store: updateOne with $set and upsert', async () => {
  const col = new InMemoryStore().collection('t');
  let r = await col.updateOne({ deviceId: 'p1' }, { $set: { 'state.level': 3 } }, { upsert: true });
  assert.equal(r.upsertedCount, 1);
  assert.equal(r.matchedCount, 0);
  assert.deepEqual((await col.findOne({ deviceId: 'p1' })).state, { level: 3 });

  r = await col.updateOne({ deviceId: 'p1' }, { $set: { 'state.level': 4 } });
  assert.equal(r.matchedCount, 1);
  assert.equal(r.modifiedCount, 1);
  r = await col.updateOne({ deviceId: 'p1' }, { $set: { 'state.level': 4 } });
  assert.equal(r.modifiedCount, 0);
  assert.equal(await col.countDocuments({}), 1);

  r = await col.updateOne({ deviceId: 'none' }, { $set: { a: 1 } });
  assert.equal(r.matchedCount, 0);
  assert.equal(await col.countDocuments({}), 1);

  await col.insertOne({ deviceId: 'p1', extra: true });
  r = await col.updateMany({ deviceId: 'p1' }, { $set: { seen: true } });
  assert.equal(r.modifiedCount, 2);
});

test('in-memory store: distinct, deleteOne/deleteMany and an increasing counter', async () => {
  const store = new InMemoryStore();
  const col = store.collection('t');
  const c0 = store.counter;
  await col.insertOne({ s: 'temp' });
  const c1 = store.counter;
  await col.insertMany([{ s: 'temp' }, { s: 'flow' }, { s: 'flow' }, { s: 'pressure' }]);
  const c2 = store.counter;
  assert.ok(c0 < c1 && c1 < c2);
  assert.deepEqual(await col.distinct('s'), ['temp', 'flow', 'pressure']);
  const ids = (await col.find({}).toArray()).map((d) => d._id);
  assert.deepEqual(ids, [...ids].sort()); // generated ids sort in insertion order
  assert.equal((await col.deleteOne({ s: 'flow' })).deletedCount, 1);
  assert.equal((await col.deleteMany({ s: 'temp' })).deletedCount, 2);
  assert.equal(await col.countDocuments({}), 2);
});

test('in-memory store: bulkWrite honours ordered:false and reports errors', async () => {
  const col = new InMemoryStore().collection('t');
  await col.insertOne({ _id: 'dup' });
  const ops = [
    { insertOne: { document: { _id: 'a' } } },
    { insertOne: { document: { _id: 'dup' } } }, // fails: duplicate _id
    { insertOne: { document: { _id: 'b' } } },
    { updateOne: { filter: { _id: 'a' }, update: { $set: { n: 1 } } } },
    { updateOne: { filter: { _id: 'z' }, update: { $set: { n: 2 } }, upsert: true } },
    { deleteOne: { filter: { _id: 'b' } } }
  ];
  const res = await col.bulkWrite(ops, { ordered: false });
  assert.equal(res.hasWriteErrors, true);
  assert.equal(res.writeErrors.length, 1);
  assert.equal(res.writeErrors[0].index, 1);
  assert.equal(res.writeErrors[0].code, 11000);
  assert.equal(res.insertedCount, 2);
  assert.equal(res.modifiedCount, 1);
  assert.equal(res.upsertedCount, 1);
  assert.equal(res.deletedCount, 1);
  assert.equal(await col.countDocuments({}), 3); // dup, a, z

  // ordered (default) stops at the first failure and throws with the partial result
  const col2 = new InMemoryStore().collection('t');
  await col2.insertOne({ _id: 'dup' });
  await assert.rejects(
    () => col2.bulkWrite([{ insertOne: { document: { _id: 'dup' } } }, { insertOne: { document: { _id: 'n' } } }]),
    (err) => err.result.insertedCount === 0 && err.code === 11000
  );
  assert.equal(await col2.countDocuments({ _id: 'n' }), 0);
});

test('in-memory store: createIndex and indexes()', async () => {
  const col = new InMemoryStore().collection('t');
  const name = await col.createIndex({ 'metadata.deviceId': 1, timestamp: -1 });
  assert.equal(name, 'metadata.deviceId_1_timestamp_-1');
  await col.createIndex({ 'metadata.deviceId': 1, timestamp: -1 }); // idempotent
  await col.createIndex({ sensor: 1 }, { name: 'by_sensor', unique: false });
  const idx = await col.indexes();
  assert.deepEqual(idx.map((i) => i.name), ['_id_', 'metadata.deviceId_1_timestamp_-1', 'by_sensor']);
  assert.deepEqual(idx[1].key, { 'metadata.deviceId': 1, timestamp: -1 });
});

test('in-memory store: reset() empties data but a held handle stays usable', async () => {
  const store = new InMemoryStore();
  const held = store.collection('t');
  await held.insertMany([{ a: 1 }, { a: 2 }]);
  await held.createIndex({ a: 1 });
  const before = store.counter;
  store.reset();
  assert.equal(await held.countDocuments({}), 0);
  assert.equal((await held.indexes()).length, 1); // only _id_
  assert.equal(store.collection('t'), held); // same object still registered
  await held.insertOne({ a: 3 });
  assert.equal(await held.countDocuments({}), 1);
  assert.ok(store.counter > before); // counter never goes backwards
});

// ---------------------------------------------------------------- 9
test('getStats() never exposes the raw URI or credentials', async () => {
  const secretUri = 'mongodb://appuser:S3cr3tPass@127.0.0.1:27099/nexusflow';
  const db = new DatabaseConnection({
    uri: secretUri,
    maxRetries: 0,
    logger: makeLogger(),
    connectFn: async (uri) => {
      throw new Error(`failed to connect to ${uri}`); // an error message that embeds the URI
    }
  });
  await db.connect();
  const stats = db.getStats();
  const json = JSON.stringify(stats);
  assert.ok(!json.includes('S3cr3tPass'));
  assert.ok(!json.includes('appuser'));
  assert.ok(!json.includes('mongodb://'));
  assert.equal(stats.host, '127.0.0.1:27099');
  assert.equal(stats.database, 'nexusflow');
  for (const key of ['mode', 'attempts', 'reconnects', 'host', 'database', 'isProductionUri', 'lastError', 'connectedAt', 'nextRetryDelayMs']) {
    assert.ok(key in stats, `missing ${key}`);
  }
  await db.close();
});

test('environment variables take effect when no explicit option is given', () => {
  const keys = ['MONGODB_URI', 'DB_MAX_RETRIES', 'DB_BASE_DELAY_MS', 'DB_MAX_DELAY_MS', 'DB_RECONNECT_MAX_ATTEMPTS'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27099/fromenv';
    process.env.DB_MAX_RETRIES = '5';
    process.env.DB_BASE_DELAY_MS = '7';
    process.env.DB_MAX_DELAY_MS = '77';
    process.env.DB_RECONNECT_MAX_ATTEMPTS = '4';
    const a = new DatabaseConnection({ logger: makeLogger() });
    assert.equal(a.options.uri, 'mongodb://127.0.0.1:27099/fromenv');
    assert.equal(a.options.maxRetries, 5);
    assert.equal(a.options.baseDelayMs, 7);
    assert.equal(a.options.maxDelayMs, 77);
    assert.equal(a.options.reconnect.maxAttempts, 4);
    const b = new DatabaseConnection({ maxRetries: 1, reconnect: { maxAttempts: 2 }, logger: makeLogger() });
    assert.equal(b.options.maxRetries, 1);
    assert.equal(b.options.reconnect.maxAttempts, 2);
    assert.equal(b.options.reconnect.baseDelayMs, 100);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('getDatabase() reuses the instance unless options are passed', async () => {
  const a = getDatabase({ logger: makeLogger(), connectFn: scriptedConnect(['fail']), maxRetries: 0 });
  assert.equal(getDatabase(), a);
  assert.equal(getDatabase(), a);
  const b = getDatabase({ logger: makeLogger(), connectFn: scriptedConnect(['fail']), maxRetries: 0 });
  assert.notEqual(b, a);
  await b.close();
});

// ---------------------------------------------------------------- 10
test('real mongod via mongodb-memory-server: connect, create an index, read it back', async (t) => {
  let server = null;
  let db = null;
  try {
    let MongoMemoryServer;
    try {
      ({ MongoMemoryServer } = require('mongodb-memory-server'));
    } catch (err) {
      t.skip(`mongodb-memory-server is not installed: ${err.message}`);
      return;
    }
    let startTimer;
    try {
      server = await Promise.race([
        MongoMemoryServer.create(),
        new Promise((_, reject) => {
          startTimer = setTimeout(() => reject(new Error('timed out starting mongod after 90s')), 90000);
        })
      ]);
    } catch (err) {
      clearTimeout(startTimer);
      t.skip(`could not start a real mongod (binary download or start failed): ${String(err.message).split('\n')[0]}`);
      return;
    }
    clearTimeout(startTimer);
    db = new DatabaseConnection({ uri: server.getUri('nexusflow_test'), maxRetries: 1, logger: makeLogger() });
    await db.connect();
    assert.equal(db.getStats().mode, 'mongodb');
    const col = db.collection('readings');
    await col.insertOne({ deviceId: 'pump-01', value: 1 });
    await col.createIndex({ deviceId: 1, value: -1 }, { name: 'device_value' });
    const idx = await col.indexes();
    assert.ok(idx.some((i) => i.name === 'device_value'));
    assert.equal(await col.countDocuments({ deviceId: 'pump-01' }), 1);
  } finally {
    if (db) await db.close();
    if (server) await server.stop();
  }
});
