'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  MODEL_NAME,
  COLLECTION_NAME,
  DEVICE_ID_PATTERN,
  DEVICE_STATUSES,
  DEFAULT_STATUS,
  deviceSchema,
  getDeviceModel,
  buildDevice
} = require('../src/database/models/Device');
const { InMemoryStore } = require('../src/database/inMemoryMock');
const { startRealMongo } = require('./helpers.realMongo');

const device = (over = {}) => ({
  deviceId: 'vdev-001',
  name: 'Turbine 1 bearing monitor',
  sensors: [
    { sensorType: 'temperature', unit: 'C' },
    { sensorType: 'vibration', unit: 'mm/s' }
  ],
  firmwareVersion: '2.4.1',
  status: 'online',
  lastSeenAt: new Date('2026-11-25T08:00:00.000Z'),
  ...over
});

// ---------------------------------------------------------------- schema

test('model names and the collection follow the sheet', () => {
  assert.equal(MODEL_NAME, 'Device');
  assert.equal(COLLECTION_NAME, 'devices');
  const Model = getDeviceModel();
  assert.equal(Model.modelName, MODEL_NAME);
  assert.equal(Model.collection.collectionName, COLLECTION_NAME);
  assert.equal(getDeviceModel(), Model); // compiled once
});

test('schema has the catalog fields and a unique deviceId index, created only on request', () => {
  const paths = Object.keys(deviceSchema.paths);
  for (const field of ['deviceId', 'name', 'sensors', 'firmwareVersion', 'status', 'lastSeenAt']) {
    assert.ok(paths.includes(field), `missing field ${field}`);
  }
  const idIndex = deviceSchema.indexes().find(([spec]) => spec.deviceId === 1);
  assert.ok(idIndex, 'deviceId index is declared');
  assert.equal(idIndex[1].unique, true);
  assert.equal(deviceSchema.options.autoCreate, false);
  assert.equal(deviceSchema.options.autoIndex, false);
  assert.equal(mongoose.connection.readyState, 0);
});

test('status values and the default are the sheet lifecycle', () => {
  assert.deepEqual(DEVICE_STATUSES, ['online', 'offline', 'maintenance', 'retired']);
  assert.equal(DEFAULT_STATUS, 'offline');
  assert.ok(DEVICE_ID_PATTERN.test('vdev-001'));
  assert.equal(DEVICE_ID_PATTERN.test('vdev 001'), false);
});

// ---------------------------------------------------------------- building

test('a valid device is returned as a clean plain document', () => {
  const doc = buildDevice(device());
  assert.equal(doc.deviceId, 'vdev-001');
  assert.equal(doc.name, 'Turbine 1 bearing monitor');
  assert.deepEqual(doc.sensors, [
    { sensorType: 'temperature', unit: 'C' },
    { sensorType: 'vibration', unit: 'mm/s' }
  ]);
  assert.equal(doc.firmwareVersion, '2.4.1');
  assert.equal(doc.status, 'online');
  assert.ok(doc.lastSeenAt instanceof Date);
  assert.equal('_id' in doc, false);
  assert.equal('__v' in doc, false);
  assert.equal('_id' in doc.sensors[0], false);
});

test('a new device starts offline, with no sensors and no last-seen time', () => {
  const doc = buildDevice({ deviceId: 'pump-02', name: 'Pump 2' });
  assert.equal(doc.status, 'offline');
  assert.deepEqual(doc.sensors, []);
  assert.equal(doc.lastSeenAt, null);
  assert.equal(doc.firmwareVersion, undefined);
});

test('invalid devices are rejected and the offending field is named', () => {
  const rejects = (over, field) =>
    assert.throws(() => buildDevice(device(over)), (e) => e.name === 'ValidationError' && field in e.errors, `expected ${field}`);

  rejects({ deviceId: 'bad id!' }, 'deviceId');
  rejects({ deviceId: '' }, 'deviceId');
  rejects({ name: '' }, 'name');
  rejects({ name: 'n'.repeat(121) }, 'name');
  rejects({ status: 'broken' }, 'status');
  rejects({ firmwareVersion: 'v2' }, 'firmwareVersion');
  rejects({ sensors: [{ sensorType: 'Temperature' }] }, 'sensors.0.sensorType');
  rejects({ sensors: [{ unit: 'C' }] }, 'sensors.0.sensorType');
  rejects({ sensors: [{ sensorType: 'pressure' }, { sensorType: 'pressure', unit: 'bar' }] }, 'sensors');
  rejects({ lastSeenAt: 'yesterday' }, 'lastSeenAt');
  assert.throws(() => buildDevice(), (e) => e.name === 'ValidationError');
});

// ---------------------------------------------------------------- stores

test('in-memory fallback registers devices and finds them by status', async () => {
  const col = new InMemoryStore().collection(COLLECTION_NAME);
  await col.insertMany([
    buildDevice(device()),
    buildDevice(device({ deviceId: 'vdev-002', name: 'Pump 2', status: 'maintenance', firmwareVersion: undefined }))
  ]);
  const inMaintenance = await col.find({ status: 'maintenance' }).toArray();
  assert.deepEqual(inMaintenance.map((d) => d.deviceId), ['vdev-002']);

  const seen = new Date('2026-11-25T09:30:00.000Z');
  const res = await col.updateOne({ deviceId: 'vdev-002' }, { $set: { lastSeenAt: seen, status: 'online' } });
  assert.equal(res.modifiedCount, 1);
  const updated = await col.findOne({ deviceId: 'vdev-002' });
  assert.equal(updated.status, 'online');
  assert.equal(updated.lastSeenAt.getTime(), seen.getTime());
});

test('real mongod: the unique deviceId index rejects a duplicate device', async (t) => {
  const started = await startRealMongo();
  if (started.skip) return t.skip(started.skip);
  const { server } = started;
  const conn = mongoose.createConnection(server.getUri('nexusflow_device_test'));
  try {
    await conn.asPromise();
    const Model = getDeviceModel(conn);
    await Model.createCollection();
    await Model.createIndexes();

    await Model.create(buildDevice(device()));
    await assert.rejects(Model.create(buildDevice(device({ name: 'copy' }))), (e) => e.code === 11000);

    const stored = await Model.findOne({ deviceId: 'vdev-001' }).lean();
    assert.equal(stored.sensors.length, 2);
    assert.ok(stored.createdAt instanceof Date);
  } finally {
    await conn.close().catch(() => {});
    await server.stop().catch(() => {});
  }
});
