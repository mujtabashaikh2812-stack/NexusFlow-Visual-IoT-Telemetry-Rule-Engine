'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  MODEL_NAME,
  COLLECTION_NAME,
  RULE_ID_PATTERN,
  DEFAULT_VERSION,
  ruleDefinitionSchema,
  getRuleDefinitionModel,
  buildRuleDefinition
} = require('../src/database/models/RuleDefinition');
const { InMemoryStore } = require('../src/database/inMemoryMock');
const { startRealMongo } = require('./helpers.realMongo');

const graph = (over = {}) => ({
  ruleId: 'high-temp-alarm',
  name: 'High temperature alarm',
  nodes: [
    { id: 'n1', type: 'input', position: { x: 0, y: 0 }, data: { sensorType: 'temperature' } },
    { id: 'n2', type: 'condition', position: { x: 200, y: 0 }, data: { operator: '>', threshold: 80 } },
    { id: 'n3', type: 'action', position: { x: 400, y: 0 }, data: { channel: 'sms' } }
  ],
  edges: [
    { id: 'e1', source: 'n1', target: 'n2' },
    { id: 'e2', source: 'n2', target: 'n3', sourceHandle: 'true', label: 'breach' }
  ],
  ...over
});

// ---------------------------------------------------------------- schema

test('model names and the collection follow the sheet', () => {
  assert.equal(MODEL_NAME, 'RuleDefinition');
  assert.equal(COLLECTION_NAME, 'rule_definitions');
  assert.equal(DEFAULT_VERSION, 1);
  const Model = getRuleDefinitionModel();
  assert.equal(Model.modelName, MODEL_NAME);
  assert.equal(Model.collection.collectionName, COLLECTION_NAME);
  assert.equal(getRuleDefinitionModel(), Model); // compiled once
});

test('schema declares the sheet fields and a unique ruleId index, created only on request', () => {
  const paths = Object.keys(ruleDefinitionSchema.paths).sort();
  for (const field of ['ruleId', 'name', 'nodes', 'edges', 'version', 'isActive']) {
    assert.ok(paths.includes(field), `missing field ${field}`);
  }
  const ruleIdIndex = ruleDefinitionSchema.indexes().find(([spec]) => spec.ruleId === 1);
  assert.ok(ruleIdIndex, 'ruleId index is declared');
  assert.equal(ruleIdIndex[1].unique, true);
  assert.equal(ruleDefinitionSchema.options.autoCreate, false);
  assert.equal(ruleDefinitionSchema.options.autoIndex, false);
  assert.equal(mongoose.connection.readyState, 0); // loading opened nothing
});

// ---------------------------------------------------------------- building

test('a valid visual graph is returned as a clean plain document', () => {
  const doc = buildRuleDefinition(graph());
  assert.equal(doc.ruleId, 'high-temp-alarm');
  assert.equal(doc.name, 'High temperature alarm');
  assert.equal(doc.nodes.length, 3);
  assert.deepEqual(doc.nodes[1].position, { x: 200, y: 0 });
  assert.equal(doc.nodes[1].data.threshold, 80);
  assert.equal(doc.edges[1].sourceHandle, 'true');
  assert.equal(doc.edges[1].label, 'breach');
  assert.equal('_id' in doc, false);
  assert.equal('__v' in doc, false);
  assert.equal('_id' in doc.nodes[0], false);
});

test('defaults: version 1, inactive, no edges needed, node type and data filled in', () => {
  const doc = buildRuleDefinition({
    ruleId: 'simple_rule',
    name: 'Simple',
    nodes: [{ id: 'only', position: { x: 1, y: 2 } }]
  });
  assert.equal(doc.version, 1);
  assert.equal(doc.isActive, false);
  assert.deepEqual(doc.edges, []);
  assert.equal(doc.nodes[0].type, 'default');
  assert.deepEqual(doc.nodes[0].data, {});
});

test('string numbers and whitespace are normalised', () => {
  const doc = buildRuleDefinition(graph({ ruleId: '  rule-7 ', name: '  Pump check  ', version: '3', isActive: true }));
  assert.equal(doc.ruleId, 'rule-7');
  assert.equal(doc.name, 'Pump check');
  assert.equal(doc.version, 3);
  assert.equal(doc.isActive, true);
});

test('invalid graphs are rejected and the offending field is named', () => {
  const rejects = (over, field) =>
    assert.throws(() => buildRuleDefinition(graph(over)), (e) => e.name === 'ValidationError' && field in e.errors, `expected ${field}`);

  rejects({ ruleId: 'has space' }, 'ruleId');
  rejects({ ruleId: 'x'.repeat(65) }, 'ruleId');
  rejects({ name: '' }, 'name');
  rejects({ name: 'n'.repeat(121) }, 'name');
  rejects({ nodes: [] }, 'nodes');
  rejects({ version: 0 }, 'version');
  rejects({ version: 1.5 }, 'version');
  rejects({ nodes: [{ id: 'a', position: { x: 0, y: 0 } }, { id: 'a', position: { x: 1, y: 1 } }] }, 'nodes');
  rejects({ nodes: [{ id: 'a', position: { x: NaN, y: 0 } }] }, 'nodes.0.position.x');
  rejects({ edges: [{ id: 'e', source: 'a', target: 'ghost' }], nodes: [{ id: 'a', position: { x: 0, y: 0 } }] }, 'edges');
  assert.throws(() => buildRuleDefinition(), (e) => e.name === 'ValidationError');
});

test('the ruleId pattern accepts letters, digits, underscore and dash only', () => {
  assert.ok(RULE_ID_PATTERN.test('Rule_01-a'));
  assert.equal(RULE_ID_PATTERN.test('rule/01'), false);
  assert.equal(RULE_ID_PATTERN.test(''), false);
});

// ---------------------------------------------------------------- stores

test('in-memory fallback saves, finds, and versions a rule graph', async () => {
  const col = new InMemoryStore().collection(COLLECTION_NAME);
  await col.insertMany([buildRuleDefinition(graph()), buildRuleDefinition(graph({ ruleId: 'pump-check', name: 'Pump', isActive: true }))]);

  const active = await col.find({ isActive: true }).toArray();
  assert.deepEqual(active.map((r) => r.ruleId), ['pump-check']);

  const updated = await col.updateOne(
    { ruleId: 'high-temp-alarm' },
    { $set: { isActive: true, version: 2, name: 'High temperature alarm v2' } }
  );
  assert.equal(updated.modifiedCount, 1);
  const saved = await col.findOne({ ruleId: 'high-temp-alarm' });
  assert.equal(saved.version, 2);
  assert.equal(saved.isActive, true);
  assert.equal(saved.edges.length, 2);
});

test('real mongod: the unique ruleId index rejects a second rule with the same id', async (t) => {
  const started = await startRealMongo();
  if (started.skip) return t.skip(started.skip);
  const { server } = started;
  const conn = mongoose.createConnection(server.getUri('nexusflow_rule_test'));
  try {
    await conn.asPromise();
    const Model = getRuleDefinitionModel(conn);
    await Model.createCollection();
    await Model.createIndexes();

    await Model.create(buildRuleDefinition(graph()));
    await assert.rejects(Model.create(buildRuleDefinition(graph({ name: 'copy' }))), (e) => e.code === 11000);

    const stored = await Model.findOne({ ruleId: 'high-temp-alarm' }).lean();
    assert.equal(stored.name, 'High temperature alarm');
    assert.equal(stored.nodes.length, 3);
    assert.ok(stored.createdAt instanceof Date);
  } finally {
    await conn.close().catch(() => {});
    await server.stop().catch(() => {});
  }
});
