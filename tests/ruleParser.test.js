'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RuleParser,
  RuleParserError,
  NODE_CATEGORIES,
  defaultRuleParser,
} = require('../src/core/ruleParser');

test('RuleParser: successfully compiles a standard linear pipeline', () => {
  const payload = {
    id: 'rule_turbine_temp',
    name: 'Turbine Temperature Alert',
    description: 'Alert when turbine temperature exceeds threshold',
    nodes: [
      {
        id: 'node_source_1',
        type: 'sourceNode',
        data: {
          category: NODE_CATEGORIES.SOURCE,
          deviceId: 'turbine-01',
          sensorType: 'temperature',
        },
      },
      {
        id: 'node_cond_1',
        type: 'conditionNode',
        data: {
          category: NODE_CATEGORIES.CONDITION,
          operator: '>',
          threshold: 85,
        },
      },
      {
        id: 'node_action_1',
        type: 'actionNode',
        data: {
          category: NODE_CATEGORIES.ACTION,
          actionType: 'sms',
          target: '+919876543210',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'node_source_1', target: 'node_cond_1' },
      { id: 'e2', source: 'node_cond_1', target: 'node_action_1' },
    ],
  };

  const ast = defaultRuleParser.parse(payload);

  assert.equal(ast.ruleId, 'rule_turbine_temp');
  assert.equal(ast.name, 'Turbine Temperature Alert');
  assert.equal(ast.isValid, true);
  assert.equal(ast.metadata.nodeCount, 3);
  assert.equal(ast.metadata.edgeCount, 2);
  assert.equal(ast.metadata.sourceCount, 1);
  assert.equal(ast.metadata.actionCount, 1);
  assert.equal(ast.metadata.isCyclic, false);
  assert.equal(ast.metadata.topology, 'linear');

  // Verify execution plan is topologically ordered
  assert.deepEqual(ast.executionPlan, ['node_source_1', 'node_cond_1', 'node_action_1']);

  // Verify normalized node configs
  assert.equal(ast.pipeline.sources[0].config.deviceId, 'turbine-01');
  assert.equal(ast.pipeline.conditions[0].config.operator, '>');
  assert.equal(ast.pipeline.conditions[0].config.threshold, 85);
  assert.equal(ast.pipeline.actions[0].config.actionType, 'sms');
});

test('RuleParser: compiles complex multi-branch pipeline with transforms', () => {
  const payload = {
    id: 'rule_complex_multi_branch',
    name: 'Multi-Branch Anomaly Pipeline',
    nodes: [
      {
        id: 'src_vibe',
        type: 'sourceNode',
        data: { category: 'source', deviceId: 'motor-88', sensorType: 'vibration' },
      },
      {
        id: 'tf_avg',
        type: 'transformNode',
        data: { category: 'transform', operation: 'moving-average', windowSize: 10 },
      },
      {
        id: 'cond_high',
        type: 'conditionNode',
        data: { category: 'condition', operator: '>=', threshold: 120 },
      },
      {
        id: 'act_sms',
        type: 'actionNode',
        data: { category: 'action', actionType: 'sms', priority: 'high' },
      },
      {
        id: 'act_webhook',
        type: 'actionNode',
        data: { category: 'action', actionType: 'webhook', target: 'https://pager.corp.local' },
      },
    ],
    edges: [
      { id: 'e1', source: 'src_vibe', target: 'tf_avg' },
      { id: 'e2', source: 'tf_avg', target: 'cond_high' },
      { id: 'e3', source: 'cond_high', target: 'act_sms' },
      { id: 'e4', source: 'cond_high', target: 'act_webhook' },
    ],
  };

  const ast = defaultRuleParser.parse(payload);

  assert.equal(ast.metadata.topology, 'multi-branch');
  assert.equal(ast.metadata.actionCount, 2);
  assert.equal(ast.pipeline.transforms.length, 1);
  assert.equal(ast.pipeline.transforms[0].config.windowSize, 10);

  // Source must precede transform; transform must precede condition; condition must precede actions
  const plan = ast.executionPlan;
  assert.ok(plan.indexOf('src_vibe') < plan.indexOf('tf_avg'));
  assert.ok(plan.indexOf('tf_avg') < plan.indexOf('cond_high'));
  assert.ok(plan.indexOf('cond_high') < plan.indexOf('act_sms'));
  assert.ok(plan.indexOf('cond_high') < plan.indexOf('act_webhook'));
});

test('RuleParser: rejects empty graph or null payload', () => {
  assert.throws(
    () => defaultRuleParser.parse(null),
    (err) => err instanceof RuleParserError && err.code === 'INVALID_PAYLOAD'
  );

  assert.throws(
    () => defaultRuleParser.parse({ nodes: [] }),
    (err) => err instanceof RuleParserError && err.code === 'EMPTY_GRAPH'
  );
});

test('RuleParser: rejects graph missing source or action nodes', () => {
  const missingSource = {
    nodes: [
      { id: 'n1', type: 'actionNode', data: { category: 'action' } },
    ],
  };
  assert.throws(
    () => defaultRuleParser.parse(missingSource),
    (err) => err instanceof RuleParserError && err.code === 'MISSING_SOURCE_NODE'
  );

  const missingAction = {
    nodes: [
      { id: 'n1', type: 'sourceNode', data: { category: 'source' } },
    ],
  };
  assert.throws(
    () => defaultRuleParser.parse(missingAction),
    (err) => err instanceof RuleParserError && err.code === 'MISSING_ACTION_NODE'
  );
});

test('RuleParser: rejects duplicate node IDs and invalid IDs', () => {
  const dup = {
    nodes: [
      { id: 'dup_id', type: 'sourceNode', data: { category: 'source' } },
      { id: 'dup_id', type: 'actionNode', data: { category: 'action' } },
    ],
  };
  assert.throws(
    () => defaultRuleParser.parse(dup),
    (err) => err instanceof RuleParserError && err.code === 'DUPLICATE_NODE_ID'
  );

  const invalidId = {
    nodes: [
      { id: '', type: 'sourceNode', data: { category: 'source' } },
    ],
  };
  assert.throws(
    () => defaultRuleParser.parse(invalidId),
    (err) => err instanceof RuleParserError && err.code === 'INVALID_NODE_ID'
  );
});

test('RuleParser: rejects orphaned edge references', () => {
  const payload = {
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source' } },
      { id: 'a1', type: 'actionNode', data: { category: 'action' } },
    ],
    edges: [{ source: 's1', target: 'ghost_node' }],
  };

  assert.throws(
    () => defaultRuleParser.parse(payload),
    (err) => err instanceof RuleParserError && err.code === 'ORPHANED_EDGE_TARGET'
  );
});

test('RuleParser: enforces edge category constraints', () => {
  // Action cannot output to another node
  const actionOutputPayload = {
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source' } },
      { id: 'a1', type: 'actionNode', data: { category: 'action' } },
      { id: 'a2', type: 'actionNode', data: { category: 'action' } },
    ],
    edges: [
      { source: 's1', target: 'a1' },
      { source: 'a1', target: 'a2' },
    ],
  };
  assert.throws(
    () => defaultRuleParser.parse(actionOutputPayload),
    (err) => err instanceof RuleParserError && err.code === 'INVALID_CONNECTION'
  );

  // Source cannot accept input
  const sourceInputPayload = {
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source' } },
      { id: 's2', type: 'sourceNode', data: { category: 'source' } },
      { id: 'a1', type: 'actionNode', data: { category: 'action' } },
    ],
    edges: [
      { source: 's1', target: 's2' },
      { source: 's2', target: 'a1' },
    ],
  };
  assert.throws(
    () => defaultRuleParser.parse(sourceInputPayload),
    (err) => err instanceof RuleParserError && err.code === 'INVALID_CONNECTION'
  );
});

test('RuleParser: detects dangling disconnected nodes', () => {
  const danglingPayload = {
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source' } },
      { id: 'a1', type: 'actionNode', data: { category: 'action' } },
      { id: 'unconnected', type: 'transformNode', data: { category: 'transform' } },
    ],
    edges: [
      { source: 's1', target: 'a1' },
    ],
  };

  assert.throws(
    () => defaultRuleParser.parse(danglingPayload),
    (err) => err instanceof RuleParserError && err.code === 'DANGLING_NODE'
  );
});

test('RuleParser: detects cyclic loops in visual graphs', () => {
  const cyclicPayload = {
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source' } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition' } },
      { id: 't1', type: 'transformNode', data: { category: 'transform' } },
      { id: 'a1', type: 'actionNode', data: { category: 'action' } },
    ],
    edges: [
      { source: 's1', target: 'c1' },
      { source: 'c1', target: 't1' },
      { source: 't1', target: 'c1' }, // Cycle: c1 -> t1 -> c1
      { source: 't1', target: 'a1' },
    ],
  };

  assert.throws(
    () => defaultRuleParser.parse(cyclicPayload),
    (err) => err instanceof RuleParserError && err.code === 'CYCLE_DETECTED'
  );
});

test('RuleParser: enforces maximum node threshold limit', () => {
  const smallParser = new RuleParser({ maxNodes: 2 });
  const payload = {
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source' } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition' } },
      { id: 'a1', type: 'actionNode', data: { category: 'action' } },
    ],
    edges: [],
  };

  assert.throws(
    () => smallParser.parse(payload),
    (err) => err instanceof RuleParserError && err.code === 'EXCEEDS_MAX_NODES'
  );
});
