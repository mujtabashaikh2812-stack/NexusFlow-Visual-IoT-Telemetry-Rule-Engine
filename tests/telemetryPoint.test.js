'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  MODEL_NAME,
  COLLECTION_NAME,
  TIME_SERIES_OPTIONS,
  telemetryPointSchema,
  getTelemetryPointModel,
  getCreateCollectionOptions,
  buildTelemetryDocument
} = require('../src/database/models/TelemetryPoint');
const { InMemoryStore } = require('../src/database/inMemoryMock');
const { startRealMongo } = require('./helpers.realMongo');

const reading = (over = {}) => ({
  timestamp: new Date('2026-11-12T10:00:00.000Z'),
  metadata: { deviceId: 'turbine-01', sensorType: 'temperature', location: 'plant-a', model: 'TX-200' },
  value: 71.5,
  unit: 'C',
  ...over
});

test('schema declares the native time-series options', () => {
  assert.deepEqual(telemetryPointSchema.options.timeseries, {
    timeField: 'timestamp',
    metaField: 'metadata',
    granularity: 'seconds'
  });
  assert.deepEqual(TIME_SERIES_OPTIONS, { timeField: 'timestamp', metaField: 'metadata', granularity: 'seconds' });
  assert.deepEqual(getCreateCollectionOptions(), { timeseries: TIME_SERIES_OPTIONS });
  assert.ok(Object.isFrozen(TIME_SERIES_OPTIONS));
});

test('metadata holds deviceId, sensorType, location and model', () => {
  const meta = telemetryPointSchema.path('metadata').schema;
  assert.deepEqual(Object.keys(meta.paths).filter((p) => p !== '_id').sort(), ['deviceId', 'location', 'model', 'sensorType']);
  assert.ok(telemetryPointSchema.path('timestamp'));
  assert.ok(telemetryPointSchema.path('value'));
});

test('loading the model needs no connection and does not create anything', () => {
  const Model = getTelemetryPointModel();
  assert.equal(Model.modelName, MODEL_NAME);
  assert.equal(Model.collection.collectionName, COLLECTION_NAME);
  assert.equal(getTelemetryPointModel(), Model); // compiled once
  assert.equal(telemetryPointSchema.options.autoCreate, false);
  assert.equal(telemetryPointSchema.options.autoIndex, false);
  assert.equal(mongoose.connection.readyState, 0);
});

test('buildTelemetryDocument returns a clean plain document', () => {
  const doc = buildTelemetryDocument({ ...reading(), timestamp: '2026-11-12T10:00:00.000Z', value: '71.5' });
  assert.ok(doc.timestamp instanceof Date);
  assert.equal(doc.timestamp.toISOString(), '2026-11-12T10:00:00.000Z');
  assert.equal(doc.value, 71.5);
  assert.deepEqual(doc.metadata, { deviceId: 'turbine-01', sensorType: 'temperature', location: 'plant-a', model: 'TX-200' });
  assert.equal(doc.unit, 'C');
  assert.equal('_id' in doc, false);
  assert.equal('__v' in doc, false);
});

test('timestamp defaults to now and optional metadata may be left out', () => {
  const before = Date.now();
  const doc = buildTelemetryDocument({ metadata: { deviceId: 'd1', sensorType: 'humidity' }, value: 40 });
  assert.ok(doc.timestamp.getTime() >= before && doc.timestamp.getTime() <= Date.now());
  assert.equal(doc.metadata.location, undefined);
  assert.equal(doc.metadata.model, undefined);
});

test('invalid readings are rejected with the offending field named', () => {
  assert.throws(() => buildTelemetryDocument({ ...reading(), value: undefined }), (e) => e.name === 'ValidationError' && 'value' in e.errors);
  assert.throws(() => buildTelemetryDocument({ ...reading(), value: 'hot' }), (e) => 'value' in e.errors);
  assert.throws(() => buildTelemetryDocument({ ...reading(), value: Infinity }), (e) => 'value' in e.errors);
  assert.throws(() => buildTelemetryDocument({ ...reading(), metadata: undefined }), (e) => 'metadata' in e.errors);
  assert.throws(
    () => buildTelemetryDocument({ ...reading(), metadata: { sensorType: 'temperature' } }),
    (e) => 'metadata.deviceId' in e.errors
  );
  assert.throws(
    () => buildTelemetryDocument({ ...reading(), metadata: { deviceId: 'd1' } }),
    (e) => 'metadata.sensorType' in e.errors
  );
  assert.throws(() => buildTelemetryDocument({ ...reading(), timestamp: 'not-a-date' }), (e) => 'timestamp' in e.errors);
  assert.throws(() => buildTelemetryDocument(), (e) => e.name === 'ValidationError');
});

test('in-memory fallback stores and returns validated readings', async () => {
  const col = new InMemoryStore().collection(COLLECTION_NAME);
  await col.insertMany([
    buildTelemetryDocument(reading()),
    buildTelemetryDocument(reading({ timestamp: new Date('2026-11-12T10:00:01.000Z'), value: 72.1 })),
    buildTelemetryDocument(reading({ metadata: { deviceId: 'pump-02', sensorType: 'pressure' }, value: 4.2, unit: 'bar' }))
  ]);
  const turbine = await col.find({ 'metadata.deviceId': 'turbine-01' }).sort({ timestamp: -1 }).toArray();
  assert.deepEqual(turbine.map((d) => d.value), [72.1, 71.5]);
  assert.equal(await col.countDocuments({ 'metadata.sensorType': 'pressure' }), 1);
});

test('real mongod: the model creates a native time-series collection', async (t) => {
  const started = await startRealMongo();
  if (started.skip) return t.skip(started.skip);
  const { server } = started;
  const conn = mongoose.createConnection(server.getUri('nexusflow_ts_test'));
  try {
    await conn.asPromise();
    const Model = getTelemetryPointModel(conn);
    await Model.createCollection();
    const infos = await conn.db.listCollections({ name: COLLECTION_NAME }).toArray();
    assert.equal(infos.length, 1);
    assert.equal(infos[0].type, 'timeseries');
    assert.equal(infos[0].options.timeseries.timeField, 'timestamp');
    assert.equal(infos[0].options.timeseries.metaField, 'metadata');
    assert.equal(infos[0].options.timeseries.granularity, 'seconds');

    await Model.insertMany([reading(), reading({ timestamp: new Date('2026-11-12T10:00:01.000Z'), value: 72.1 })]);
    const latest = await Model.findOne({ 'metadata.deviceId': 'turbine-01' }).sort({ timestamp: -1 }).lean();
    assert.equal(latest.value, 72.1);
    assert.equal(latest.metadata.model, 'TX-200');
  } finally {
    await conn.close();
    await server.stop();
  }
});
