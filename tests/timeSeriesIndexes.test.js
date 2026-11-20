'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  TIME_SERIES_INDEXES,
  ensureTimeSeriesIndexes,
  verifyTimeSeriesIndexes
} = require('../src/database/indexes/timeSeriesIndexes');
const { COLLECTION_NAME, getTelemetryPointModel, buildTelemetryDocument } = require('../src/database/models/TelemetryPoint');
const { DatabaseConnection } = require('../src/database/dbConnection');
const { InMemoryStore } = require('../src/database/inMemoryMock');
const { startRealMongo } = require('./helpers.realMongo');

const DEVICE_INDEX = 'metadata.deviceId_1_timestamp_-1';
const SENSOR_INDEX = 'metadata.sensorType_1_timestamp_-1';

test('index definitions match the task sheet', () => {
  assert.deepEqual(
    TIME_SERIES_INDEXES.map((i) => ({ name: i.name, key: { ...i.key } })),
    [
      { name: DEVICE_INDEX, key: { 'metadata.deviceId': 1, timestamp: -1 } },
      { name: SENSOR_INDEX, key: { 'metadata.sensorType': 1, timestamp: -1 } }
    ]
  );
  assert.ok(Object.isFrozen(TIME_SERIES_INDEXES));
});

test('ensureTimeSeriesIndexes builds both indexes on the in-memory fallback', async () => {
  const col = new InMemoryStore().collection(COLLECTION_NAME);
  const result = await ensureTimeSeriesIndexes(col);
  assert.deepEqual(result, { created: [DEVICE_INDEX, SENSOR_INDEX], existing: [] });
  const idx = await col.indexes();
  assert.deepEqual(idx.map((i) => i.name), ['_id_', DEVICE_INDEX, SENSOR_INDEX]);
  assert.deepEqual(idx[1].key, { 'metadata.deviceId': 1, timestamp: -1 });
  assert.deepEqual(idx[2].key, { 'metadata.sensorType': 1, timestamp: -1 });
});

test('ensureTimeSeriesIndexes is idempotent', async () => {
  const col = new InMemoryStore().collection(COLLECTION_NAME);
  await ensureTimeSeriesIndexes(col);
  const again = await ensureTimeSeriesIndexes(col);
  assert.deepEqual(again, { created: [], existing: [DEVICE_INDEX, SENSOR_INDEX] });
  assert.equal((await col.indexes()).length, 3);
});

test('an equivalent index under another name is reused, not duplicated', async () => {
  const col = new InMemoryStore().collection(COLLECTION_NAME);
  await col.createIndex({ 'metadata.deviceId': 1, timestamp: -1 }, { name: 'custom_device_time' });
  const result = await ensureTimeSeriesIndexes(col);
  assert.deepEqual(result, { created: [SENSOR_INDEX], existing: ['custom_device_time'] });
});

test('a different sort direction does not count as the required index', async () => {
  const col = new InMemoryStore().collection(COLLECTION_NAME);
  await col.createIndex({ 'metadata.deviceId': 1, timestamp: 1 });
  const verify = await verifyTimeSeriesIndexes(col);
  assert.equal(verify.ok, false);
  assert.deepEqual(verify.missing, [DEVICE_INDEX, SENSOR_INDEX]);
});

test('verifyTimeSeriesIndexes reports present and missing indexes', async () => {
  const col = new InMemoryStore().collection(COLLECTION_NAME);
  assert.deepEqual(await verifyTimeSeriesIndexes(col), { ok: false, present: [], missing: [DEVICE_INDEX, SENSOR_INDEX] });
  await ensureTimeSeriesIndexes(col);
  assert.deepEqual(await verifyTimeSeriesIndexes(col), { ok: true, present: [DEVICE_INDEX, SENSOR_INDEX], missing: [] });
});

test('works through a DatabaseConnection running in fallback mode', async () => {
  const quiet = { info() {}, warn() {}, error() {}, log() {} };
  const db = new DatabaseConnection({
    connectFn: async () => {
      throw new Error('simulated connect failure');
    },
    maxRetries: 0,
    logger: quiet
  });
  try {
    await db.connect();
    assert.equal(db.mode, 'memory');
    const result = await ensureTimeSeriesIndexes(db);
    assert.deepEqual(result.created, [DEVICE_INDEX, SENSOR_INDEX]);
    const col = db.collection(COLLECTION_NAME);
    await col.insertOne(buildTelemetryDocument({ metadata: { deviceId: 'd1', sensorType: 'temperature' }, value: 20 }));
    assert.equal((await col.indexes()).length, 3);
    assert.equal((await verifyTimeSeriesIndexes(db)).ok, true);
  } finally {
    await db.close();
  }
});

test('rejects a missing target', async () => {
  await assert.rejects(() => ensureTimeSeriesIndexes(null), TypeError);
  await assert.rejects(() => verifyTimeSeriesIndexes({}), TypeError);
});

test('real mongod: both indexes are built on the time-series collection', async (t) => {
  const started = await startRealMongo();
  if (started.skip) return t.skip(started.skip);
  const { server } = started;
  const conn = mongoose.createConnection(server.getUri('nexusflow_idx_test'));
  try {
    await conn.asPromise();
    await getTelemetryPointModel(conn).createCollection();
    const col = conn.db.collection(COLLECTION_NAME);

    const first = await ensureTimeSeriesIndexes(col);
    assert.deepEqual(first.created, [DEVICE_INDEX, SENSOR_INDEX]);
    const second = await ensureTimeSeriesIndexes(col);
    assert.deepEqual(second, { created: [], existing: [DEVICE_INDEX, SENSOR_INDEX] });

    const names = (await col.indexes()).map((i) => i.name);
    assert.ok(names.includes(DEVICE_INDEX) && names.includes(SENSOR_INDEX));
    assert.equal((await verifyTimeSeriesIndexes(col)).ok, true);
    const infos = await conn.db.listCollections({ name: COLLECTION_NAME }).toArray();
    assert.equal(infos[0].type, 'timeseries'); // still a time-series collection
  } finally {
    await conn.close();
    await server.stop();
  }
});
