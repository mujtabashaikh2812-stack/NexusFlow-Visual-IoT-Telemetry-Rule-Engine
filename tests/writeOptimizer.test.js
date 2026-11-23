'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  WRITE_PROFILES,
  DEFAULT_PROFILE,
  validateWriteConcern,
  resolveWriteConcern,
  optimizeCollection,
  measureWriteEfficiency
} = require('../src/database/services/writeOptimizer');
const { COLLECTION_NAME, getTelemetryPointModel } = require('../src/database/models/TelemetryPoint');
const { InMemoryStore } = require('../src/database/inMemoryMock');
const { startRealMongo } = require('./helpers.realMongo');

const quiet = { info() {}, warn() {}, error() {}, log() {} };

/** Records every bulkWrite call (operations count and options) and forwards to a real in-memory collection. */
function recordingCollection() {
  const inner = new InMemoryStore().collection(COLLECTION_NAME);
  const col = {
    inner,
    collectionName: COLLECTION_NAME,
    calls: [],
    bulkWrite(ops, options) {
      col.calls.push({ size: ops.length, options: { ...options } });
      return inner.bulkWrite(ops, options);
    }
  };
  return col;
}

const withProfileEnv = (value, fn) => {
  const saved = process.env.TELEMETRY_WRITE_PROFILE;
  if (value === undefined) delete process.env.TELEMETRY_WRITE_PROFILE;
  else process.env.TELEMETRY_WRITE_PROFILE = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TELEMETRY_WRITE_PROFILE;
    else process.env.TELEMETRY_WRITE_PROFILE = saved;
  }
};

test('profiles: buffered is w 1 without journal (default), durable waits for majority and journal', () => {
  assert.deepEqual(WRITE_PROFILES.buffered, { w: 1, j: false });
  assert.deepEqual(WRITE_PROFILES.durable, { w: 'majority', j: true });
  assert.equal(DEFAULT_PROFILE, 'buffered');
  assert.ok(Object.isFrozen(WRITE_PROFILES));
  withProfileEnv(undefined, () => {
    assert.deepEqual(resolveWriteConcern({}), { w: 1, j: false });
  });
});

test('environment selects the profile; an explicit option overrides the environment', () => {
  withProfileEnv('durable', () => {
    assert.deepEqual(resolveWriteConcern({}), { w: 'majority', j: true });
    assert.deepEqual(resolveWriteConcern({ profile: 'buffered' }), { w: 1, j: false });
  });
  withProfileEnv('  BUFFERED ', () => {
    assert.deepEqual(resolveWriteConcern({}), { w: 1, j: false });
  });
  withProfileEnv('', () => {
    assert.deepEqual(resolveWriteConcern({}), { w: 1, j: false });
  });
});

test('an explicit writeConcern wins over the profile and fills defaults', () => {
  assert.deepEqual(resolveWriteConcern({ profile: 'durable', writeConcern: { w: 2, j: false } }), { w: 2, j: false });
  assert.deepEqual(validateWriteConcern({ w: 'majority' }), { w: 'majority', j: false });
  assert.deepEqual(validateWriteConcern({}), { w: 1, j: false });
});

test('bad write concern values and unknown profiles are rejected', () => {
  assert.throws(() => resolveWriteConcern({ profile: 'fast' }), RangeError);
  assert.throws(() => validateWriteConcern({ w: 0 }), RangeError);
  assert.throws(() => validateWriteConcern({ w: 1.5 }), RangeError);
  assert.throws(() => validateWriteConcern({ w: 'two' }), RangeError);
  assert.throws(() => validateWriteConcern({ w: 1, j: 'yes' }), TypeError);
  assert.throws(() => validateWriteConcern(null), TypeError);
});

test('optimizeCollection sends the write concern and stays unordered on every bulkWrite', async () => {
  const col = recordingCollection();
  const tuned = optimizeCollection(col, { profile: 'buffered' });
  assert.equal(tuned.collectionName, COLLECTION_NAME);
  assert.deepEqual(tuned.writeConcern, { w: 1, j: false });

  const ops = [{ insertOne: { document: { timestamp: new Date(), metadata: { deviceId: 'a', sensorType: 'temperature' }, value: 1 } } }];
  const result = await tuned.bulkWrite(ops);
  assert.equal(result.insertedCount, 1);
  assert.equal(col.calls.length, 1);
  assert.equal(col.calls[0].size, 1);
  assert.deepEqual(col.calls[0].options, { ordered: false, writeConcern: { w: 1, j: false } });

  // The tuned concern is enforced: a caller's writeConcern is overridden, while ordered stays the caller's choice.
  await tuned.bulkWrite(ops, { ordered: true, writeConcern: { w: 'majority', j: true } });
  assert.equal(col.calls[1].options.ordered, true);
  assert.deepEqual(col.calls[1].options.writeConcern, { w: 1, j: false });
});

test('optimizeCollection refuses a target without bulkWrite', () => {
  assert.throws(() => optimizeCollection({}), TypeError);
  assert.throws(() => optimizeCollection(null), TypeError);
});

test('measureWriteEfficiency: every reading is stored, in unordered batches, with the buffered concern', async () => {
  const col = recordingCollection();
  const report = await measureWriteEfficiency(col, { profile: 'buffered', writes: 1000, batchSize: 100, devices: 20, logger: quiet });
  assert.equal(report.complete, true);
  assert.equal(report.readings, 1000);
  assert.equal(report.written, 1000);
  assert.equal(report.failed, 0);
  assert.equal(report.dropped, 0);
  assert.equal(report.bulkCalls, 10);
  assert.equal(report.averageBatch, 100);
  assert.deepEqual(report.writeConcern, { w: 1, j: false });
  assert.ok(report.writesPerSec > 0);
  assert.equal(await col.inner.countDocuments({}), 1000);
  assert.ok(col.calls.every((c) => c.options.ordered === false && c.options.writeConcern.w === 1 && c.options.writeConcern.j === false));
  const devices = await col.inner.distinct('metadata.deviceId');
  assert.equal(devices.length, 20);
});

test('measureWriteEfficiency: a partial last batch is still written', async () => {
  const col = recordingCollection();
  const report = await measureWriteEfficiency(col, { profile: 'durable', writes: 250, batchSize: 100, logger: quiet });
  assert.equal(report.complete, true);
  assert.equal(report.bulkCalls, 3);
  assert.deepEqual(report.writeConcern, { w: 'majority', j: true });
  assert.deepEqual(col.calls.map((c) => c.size), [100, 100, 50]);
  assert.equal(await col.inner.countDocuments({}), 250);
});

test('measureWriteEfficiency rejects bad sizes', async () => {
  const col = recordingCollection();
  await assert.rejects(() => measureWriteEfficiency(col, { writes: 0 }), RangeError);
  await assert.rejects(() => measureWriteEfficiency(col, { batchSize: 2.5 }), RangeError);
  await assert.rejects(() => measureWriteEfficiency(col, { profile: 'nope' }), RangeError);
});

test('real mongod: buffered and durable writes both land in the time-series collection', async (t) => {
  const started = await startRealMongo();
  if (started.skip) return t.skip(started.skip);
  const { server } = started;
  const conn = mongoose.createConnection(server.getUri('nexusflow_write_profiles'));
  try {
    await conn.asPromise();
    await getTelemetryPointModel(conn).createCollection();
    const col = conn.db.collection(COLLECTION_NAME);

    const buffered = await measureWriteEfficiency(col, { profile: 'buffered', writes: 2000, batchSize: 500, logger: quiet });
    assert.equal(buffered.complete, true);
    assert.equal(buffered.bulkCalls, 4);
    assert.equal(await col.countDocuments({}), 2000);

    const durable = await measureWriteEfficiency(col, { profile: 'durable', writes: 1000, batchSize: 500, logger: quiet });
    assert.equal(durable.complete, true);
    assert.equal(durable.written, 1000);
    assert.equal(await col.countDocuments({}), 3000);

    console.log(
      `write efficiency (real mongod, local): buffered ${buffered.writesPerSec}/s over ${buffered.bulkCalls} bulk calls, durable ${durable.writesPerSec}/s over ${durable.bulkCalls} bulk calls`
    );
  } finally {
    await conn.close();
    await server.stop();
  }
});
