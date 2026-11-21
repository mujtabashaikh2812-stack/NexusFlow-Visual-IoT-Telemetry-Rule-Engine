'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  DEFAULT_RETENTION_SECONDS,
  resolveRetentionSeconds,
  getRetentionPolicy,
  applyRetentionPolicy,
  verifyRetentionPolicy,
  pruneExpiredReadings,
  startMemoryPruner
} = require('../src/database/services/retentionPolicy');
const { COLLECTION_NAME, getTelemetryPointModel, buildTelemetryDocument } = require('../src/database/models/TelemetryPoint');
const { BatchWriter } = require('../src/database/services/batchWriter');
const { DatabaseConnection } = require('../src/database/dbConnection');
const { InMemoryStore } = require('../src/database/inMemoryMock');
const { startRealMongo } = require('./helpers.realMongo');

const quiet = { info() {}, warn() {}, error() {}, log() {} };
const ENV_KEYS = ['TELEMETRY_RETENTION_SECONDS', 'TELEMETRY_RETENTION_DAYS'];

function withEnv(values, fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const point = (timestamp, value = 1) => ({ timestamp, metadata: { deviceId: 'pump-01', sensorType: 'pressure' }, value });

async function waitFor(fn, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

test('default retention is 30 days (2592000 seconds)', () => {
  assert.equal(DEFAULT_RETENTION_SECONDS, 2592000);
  withEnv({}, () => assert.equal(resolveRetentionSeconds(), 2592000));
});

test('retention is configurable: option beats environment beats default', () => {
  withEnv({ TELEMETRY_RETENTION_SECONDS: '600' }, () => {
    assert.equal(resolveRetentionSeconds(), 600);
    assert.equal(resolveRetentionSeconds({ expireAfterSeconds: 90 }), 90);
    assert.equal(resolveRetentionSeconds({ retentionDays: 2 }), 172800);
  });
  withEnv({ TELEMETRY_RETENTION_DAYS: '7' }, () => assert.equal(resolveRetentionSeconds(), 604800));
  withEnv({ TELEMETRY_RETENTION_DAYS: '7', TELEMETRY_RETENTION_SECONDS: '60' }, () => assert.equal(resolveRetentionSeconds(), 60));
  withEnv({}, () => assert.equal(resolveRetentionSeconds({ retentionDays: 0.5 }), 43200));
});

test("'off' disables expiry; nonsense is refused instead of silently using the default", () => {
  withEnv({ TELEMETRY_RETENTION_SECONDS: 'off' }, () => assert.equal(resolveRetentionSeconds(), null));
  withEnv({}, () => {
    assert.equal(resolveRetentionSeconds({ expireAfterSeconds: 'OFF' }), null);
    assert.equal(resolveRetentionSeconds({ expireAfterSeconds: null }), null);
    for (const bad of [0, -1, 'abc', Number.NaN, 2 ** 40]) {
      assert.throws(() => resolveRetentionSeconds({ expireAfterSeconds: bad }), RangeError, String(bad));
    }
  });
  withEnv({ TELEMETRY_RETENTION_SECONDS: 'soon' }, () => assert.throws(() => resolveRetentionSeconds(), /TELEMETRY_RETENTION_SECONDS/));
});

test('in-memory fallback: apply and verify say nothing can expire by itself, nothing throws', async () => {
  const col = new InMemoryStore().collection(COLLECTION_NAME);
  const applied = await applyRetentionPolicy(col, { expireAfterSeconds: 3600 });
  assert.deepEqual(applied, { mode: 'memory', action: 'skipped', expireAfterSeconds: 3600, previous: null });
  const verified = await verifyRetentionPolicy(col, { expireAfterSeconds: 3600 });
  assert.equal(verified.ok, false);
  assert.equal(verified.mode, 'memory');
  assert.match(verified.problems[0], /in-memory fallback/);
});

test('a single native-style collection is refused with a clear message', async () => {
  await assert.rejects(() => applyRetentionPolicy({ dbName: 'x', collectionName: 'y', insertMany() {} }), /not a single collection/);
  await assert.rejects(() => applyRetentionPolicy(null), TypeError);
  await assert.rejects(() => applyRetentionPolicy({}), TypeError);
});

test('pruneExpiredReadings removes only readings older than the limit', async () => {
  const col = new InMemoryStore().collection(COLLECTION_NAME);
  const now = Date.UTC(2026, 10, 15, 12, 0, 0);
  const at = (secondsAgo) => buildTelemetryDocument(point(new Date(now - secondsAgo * 1000), secondsAgo));
  await col.insertMany([at(7200), at(3601), at(3599), at(10)]);
  assert.equal(await pruneExpiredReadings(col, { expireAfterSeconds: 3600, now }), 2);
  const left = (await col.find({}).toArray()).map((d) => d.value).sort((a, b) => a - b);
  assert.deepEqual(left, [10, 3599]);
  assert.equal(await pruneExpiredReadings(col, { expireAfterSeconds: 3600, now }), 0);
  assert.equal(await pruneExpiredReadings(col, { expireAfterSeconds: 'off', now }), 0); // off keeps everything
  assert.equal(await col.countDocuments({}), 2);
  await assert.rejects(() => pruneExpiredReadings(null), TypeError);
});

test('startMemoryPruner expires old readings on a timer and can be stopped', async () => {
  const col = new InMemoryStore().collection(COLLECTION_NAME);
  await col.insertMany([
    buildTelemetryDocument(point(new Date(Date.now() - 3600 * 1000), 1)),
    buildTelemetryDocument(point(new Date(), 2))
  ]);
  const stop = startMemoryPruner(col, { expireAfterSeconds: 60, intervalMs: 20 });
  try {
    assert.ok(await waitFor(async () => (await col.countDocuments({})) === 1, 3000));
    assert.equal((await col.find({}).toArray())[0].value, 2);
  } finally {
    stop();
  }
  assert.throws(() => startMemoryPruner(col, { expireAfterSeconds: 'bad' }), RangeError);
  assert.throws(() => startMemoryPruner(col, { intervalMs: 0 }), RangeError);
});

test('DatabaseConnection exposes the native db only while connected to MongoDB', async () => {
  const fakeDb = { name: 'fake' };
  const db = new DatabaseConnection({ connectFn: async () => ({ db: fakeDb }), maxRetries: 0, logger: quiet });
  assert.equal(db.nativeDb, null);
  await db.connect();
  assert.equal(db.nativeDb, fakeDb);
  await db.close();
  assert.equal(db.nativeDb, null);

  const offline = new DatabaseConnection({
    connectFn: async () => {
      throw new Error('simulated connect failure');
    },
    maxRetries: 0,
    logger: quiet
  });
  await offline.connect();
  assert.equal(offline.nativeDb, null);
  assert.equal((await applyRetentionPolicy(offline)).action, 'skipped'); // fallback mode: no crash
  await offline.close();
});

test('real mongod: apply creates the collection with the policy, then is idempotent, updates and verifies', async (t) => {
  const started = await startRealMongo();
  if (started.skip) return t.skip(started.skip);
  const { server } = started;
  const conn = mongoose.createConnection(server.getUri('nexusflow_ttl_test'));
  try {
    await conn.asPromise();
    const db = conn.db;

    assert.deepEqual(await getRetentionPolicy(db), { mode: 'mongodb', exists: false, isTimeSeries: false, expireAfterSeconds: null });
    assert.equal((await verifyRetentionPolicy(db, { expireAfterSeconds: 2592000 })).ok, false);

    // 1. created with the sheet value
    const created = await applyRetentionPolicy(db, { expireAfterSeconds: 2592000 });
    assert.deepEqual(created, { mode: 'mongodb', action: 'created', expireAfterSeconds: 2592000, previous: null });
    const [info] = await db.listCollections({ name: COLLECTION_NAME }).toArray();
    assert.equal(info.type, 'timeseries');
    assert.equal(info.options.expireAfterSeconds, 2592000);
    assert.equal(info.options.timeseries.timeField, 'timestamp');
    assert.equal(info.options.timeseries.metaField, 'metadata');

    // 2. same value again: nothing to do
    assert.equal((await applyRetentionPolicy(db, { expireAfterSeconds: 2592000 })).action, 'unchanged');
    const ok = await verifyRetentionPolicy(db, { expireAfterSeconds: 2592000 });
    assert.deepEqual({ ok: ok.ok, actual: ok.actual, expected: ok.expected, problems: ok.problems }, { ok: true, actual: 2592000, expected: 2592000, problems: [] });

    // 3. a different value is applied with collMod, through the mongoose connection too
    const updated = await applyRetentionPolicy(conn, { retentionDays: 7 });
    assert.deepEqual(updated, { mode: 'mongodb', action: 'updated', expireAfterSeconds: 604800, previous: 2592000 });
    assert.equal((await getRetentionPolicy(db)).expireAfterSeconds, 604800);
    const bad = await verifyRetentionPolicy(db, { expireAfterSeconds: 2592000 });
    assert.equal(bad.ok, false);
    assert.match(bad.problems[0], /604800/);

    // 4. off removes the limit
    assert.equal((await applyRetentionPolicy(db, { expireAfterSeconds: 'off' })).action, 'updated');
    assert.equal((await getRetentionPolicy(db)).expireAfterSeconds, null);
    assert.equal((await verifyRetentionPolicy(db, { expireAfterSeconds: 'off' })).ok, true);

    // the other schema pieces survived all the changes
    const [after] = await db.listCollections({ name: COLLECTION_NAME }).toArray();
    assert.equal(after.type, 'timeseries');
  } finally {
    await conn.close();
    await server.stop();
  }
});

test('real mongod: an existing non-time-series collection is refused, not converted or damaged', async (t) => {
  const started = await startRealMongo();
  if (started.skip) return t.skip(started.skip);
  const { server } = started;
  const conn = mongoose.createConnection(server.getUri('nexusflow_ttl_plain'));
  try {
    await conn.asPromise();
    await conn.db.collection(COLLECTION_NAME).insertOne({ keep: 'me' });
    await assert.rejects(() => applyRetentionPolicy(conn.db, { expireAfterSeconds: 60 }), /not a time-series/);
    const v = await verifyRetentionPolicy(conn.db, { expireAfterSeconds: 60 });
    assert.equal(v.ok, false);
    assert.equal(v.isTimeSeries, false);
    assert.equal(await conn.db.collection(COLLECTION_NAME).countDocuments({}), 1);
  } finally {
    await conn.close();
    await server.stop();
  }
});

test('real mongod: old telemetry really expires on its own and recent telemetry stays', async (t) => {
  // The TTL monitor normally wakes once a minute; ask this throwaway server to wake every second.
  const started = await startRealMongo({ instance: { args: ['--setParameter', 'ttlMonitorSleepSecs=1'] } });
  if (started.skip) return t.skip(started.skip);
  const { server } = started;
  const conn = mongoose.createConnection(server.getUri('nexusflow_ttl_expiry'));
  let writer;
  try {
    await conn.asPromise();
    await applyRetentionPolicy(conn.db, { expireAfterSeconds: 120 });
    const col = conn.db.collection(COLLECTION_NAME);

    writer = new BatchWriter(col, { batchSize: 50, flushIntervalMs: 60000, logger: quiet });
    const day = 24 * 3600 * 1000;
    for (let i = 0; i < 10; i++) writer.add(point(new Date(Date.now() - 10 * day + i * 1000), i)); // 10 days old
    for (let i = 0; i < 10; i++) writer.add(point(new Date(Date.now() - i * 1000), 100 + i)); // fresh
    const result = await writer.flush();
    assert.equal(result.written, 20);
    assert.equal(await col.countDocuments({}), 20);

    assert.ok(await waitFor(async () => (await col.countDocuments({})) === 10, 90000), 'old readings should have expired');
    const values = (await col.find({}).toArray()).map((d) => d.value).sort((a, b) => a - b);
    assert.deepEqual(values, [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
  } finally {
    if (writer) await writer.close();
    await conn.close();
    await server.stop();
  }
});

test('retention can be applied to a collection already created through the TelemetryPoint model', async (t) => {
  const started = await startRealMongo();
  if (started.skip) return t.skip(started.skip);
  const { server } = started;
  const conn = mongoose.createConnection(server.getUri('nexusflow_ttl_model'));
  try {
    await conn.asPromise();
    await getTelemetryPointModel(conn).createCollection(); // Day 2 path: no expiry
    assert.equal((await getRetentionPolicy(conn.db)).expireAfterSeconds, null);
    const r = await applyRetentionPolicy(conn.db, { expireAfterSeconds: 3600 }); // Day 5 brings it to the policy
    assert.equal(r.action, 'updated');
    assert.equal((await verifyRetentionPolicy(conn.db, { expireAfterSeconds: 3600 })).ok, true);
  } finally {
    await conn.close();
    await server.stop();
  }
});
