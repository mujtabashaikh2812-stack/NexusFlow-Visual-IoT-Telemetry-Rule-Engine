'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  MODEL_NAME,
  COLLECTION_NAME,
  ACTION_MAX_LENGTH,
  ruleAuditLogSchema,
  getRuleAuditLogModel,
  buildRuleAuditLog
} = require('../src/database/models/RuleAuditLog');
const { InMemoryStore } = require('../src/database/inMemoryMock');
const { startRealMongo } = require('./helpers.realMongo');

const trigger = (over = {}) => ({
  ruleId: 'high-temp-alarm',
  deviceId: 'turbine-01',
  triggerValue: 91.2,
  threshold: 80,
  actionDispatched: 'sms',
  latencyMs: 4.5,
  timestamp: new Date('2026-11-22T10:00:00.000Z'),
  ...over
});

// ---------------------------------------------------------------- schema

test('model name and collection follow the sheet', () => {
  assert.equal(MODEL_NAME, 'RuleAuditLog');
  assert.equal(COLLECTION_NAME, 'rule_audit_logs');
  assert.equal(ACTION_MAX_LENGTH, 64);
  const Model = getRuleAuditLogModel();
  assert.equal(Model.modelName, MODEL_NAME);
  assert.equal(Model.collection.collectionName, COLLECTION_NAME);
  assert.equal(getRuleAuditLogModel(), Model); // compiled once
});

test('schema has the trigger fields and a timestamp, and creates nothing on load', () => {
  const paths = Object.keys(ruleAuditLogSchema.paths);
  for (const field of ['ruleId', 'deviceId', 'triggerValue', 'threshold', 'actionDispatched', 'latencyMs', 'timestamp']) {
    assert.ok(paths.includes(field), `missing field ${field}`);
  }
  assert.equal(ruleAuditLogSchema.options.autoCreate, false);
  assert.equal(ruleAuditLogSchema.options.autoIndex, false);
  assert.equal(mongoose.connection.readyState, 0);
});

// ---------------------------------------------------------------- building

test('a valid trigger is returned as a clean plain document', () => {
  const doc = buildRuleAuditLog(trigger());
  assert.equal(doc.ruleId, 'high-temp-alarm');
  assert.equal(doc.deviceId, 'turbine-01');
  assert.equal(doc.triggerValue, 91.2);
  assert.equal(doc.threshold, 80);
  assert.equal(doc.actionDispatched, 'sms');
  assert.equal(doc.latencyMs, 4.5);
  assert.ok(doc.timestamp instanceof Date);
  assert.equal(doc.timestamp.toISOString(), '2026-11-22T10:00:00.000Z');
  assert.equal('_id' in doc, false);
  assert.equal('__v' in doc, false);
});

test('a trigger with no action sent keeps actionDispatched as null', () => {
  const doc = buildRuleAuditLog(trigger({ actionDispatched: undefined }));
  assert.equal(doc.actionDispatched, null);
  assert.ok('actionDispatched' in doc);
});

test('timestamp defaults to now and numeric strings are converted', () => {
  const before = Date.now();
  const doc = buildRuleAuditLog(trigger({ timestamp: undefined, triggerValue: '91.2', latencyMs: '0' }));
  assert.ok(doc.timestamp.getTime() >= before && doc.timestamp.getTime() <= Date.now());
  assert.equal(doc.triggerValue, 91.2);
  assert.equal(doc.latencyMs, 0);
});

test('invalid trigger entries are rejected and the offending field is named', () => {
  const rejects = (over, field) =>
    assert.throws(() => buildRuleAuditLog(trigger(over)), (e) => e.name === 'ValidationError' && field in e.errors, `expected ${field}`);

  rejects({ ruleId: 'bad rule!' }, 'ruleId');
  rejects({ ruleId: undefined }, 'ruleId');
  rejects({ deviceId: 'bad device' }, 'deviceId');
  rejects({ deviceId: undefined }, 'deviceId');
  rejects({ triggerValue: undefined }, 'triggerValue');
  rejects({ triggerValue: 'hot' }, 'triggerValue');
  rejects({ triggerValue: Infinity }, 'triggerValue');
  rejects({ threshold: undefined }, 'threshold');
  rejects({ threshold: NaN }, 'threshold');
  rejects({ actionDispatched: '' }, 'actionDispatched');
  rejects({ actionDispatched: 'a'.repeat(ACTION_MAX_LENGTH + 1) }, 'actionDispatched');
  rejects({ latencyMs: undefined }, 'latencyMs');
  rejects({ latencyMs: -1 }, 'latencyMs');
  rejects({ latencyMs: 'fast' }, 'latencyMs');
  rejects({ timestamp: 'yesterday' }, 'timestamp');
  assert.throws(() => buildRuleAuditLog(), (e) => e.name === 'ValidationError');
});

// ---------------------------------------------------------------- stores

test('in-memory fallback keeps the trail and returns a rule history newest first', async () => {
  const col = new InMemoryStore().collection(COLLECTION_NAME);
  await col.insertMany([
    buildRuleAuditLog(trigger()),
    buildRuleAuditLog(trigger({ timestamp: new Date('2026-11-22T10:00:05.000Z'), triggerValue: 93.4, latencyMs: 6 })),
    buildRuleAuditLog(trigger({ ruleId: 'low-pressure-alarm', deviceId: 'pump-02', actionDispatched: undefined, threshold: 2 }))
  ]);
  const history = await col.find({ ruleId: 'high-temp-alarm' }).sort({ timestamp: -1 }).toArray();
  assert.deepEqual(history.map((d) => d.triggerValue), [93.4, 91.2]);
  assert.equal(await col.countDocuments({ actionDispatched: null }), 1);
  assert.equal(await col.countDocuments({ deviceId: 'pump-02' }), 1);
});

test('real mongod: a trigger entry is stored as a regular collection and read back intact', async (t) => {
  const started = await startRealMongo();
  if (started.skip) return t.skip(started.skip);
  const { server } = started;
  const conn = mongoose.createConnection(server.getUri('nexusflow_audit_test'));
  try {
    await conn.asPromise();
    const Model = getRuleAuditLogModel(conn);
    await Model.createCollection();
    const infos = await conn.db.listCollections({ name: COLLECTION_NAME }).toArray();
    assert.equal(infos.length, 1);
    assert.notEqual(infos[0].type, 'timeseries');

    await Model.create(buildRuleAuditLog(trigger()));
    await Model.create(buildRuleAuditLog(trigger({ actionDispatched: undefined, timestamp: new Date('2026-11-22T10:00:01.000Z') })));
    const stored = await Model.find({ ruleId: 'high-temp-alarm' }).sort({ timestamp: 1 }).lean();
    assert.equal(stored.length, 2);
    assert.equal(stored[0].actionDispatched, 'sms');
    assert.equal(stored[0].latencyMs, 4.5);
    assert.equal(stored[1].actionDispatched, null);
    assert.ok(stored[1].timestamp instanceof Date);
  } finally {
    await conn.close().catch(() => {});
    await server.stop().catch(() => {});
  }
});
