'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RuleEvaluator } = require('../src/core/ruleEvaluator');
const { defaultRuleParser } = require('../src/core/ruleParser');

test('RuleEvaluator: registers and undeploys compiled AST rules', () => {
  const evaluator = new RuleEvaluator();
  const rawRule = {
    id: 'rule_turbine_vibe',
    name: 'Turbine Vibration Sentinel',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'turbine-01', sensorType: 'vibration' } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 10 } },
      { id: 'a1', type: 'actionNode', data: { category: 'action', actionType: 'alert' } },
    ],
    edges: [
      { id: 'e1', source: 's1', target: 'c1' },
      { id: 'e2', source: 'c1', target: 'a1' },
    ],
  };

  const ast = defaultRuleParser.parse(rawRule);
  const regResult = evaluator.registerRule(ast);

  assert.equal(regResult.ruleId, 'rule_turbine_vibe');
  assert.equal(regResult.status, 'active');
  assert.equal(evaluator.getActiveRules().length, 1);

  const rule = evaluator.getRule('rule_turbine_vibe');
  assert.equal(rule.ast.ruleId, 'rule_turbine_vibe');
  assert.equal(rule.metrics.evaluationsCount, 0);

  const undeployed = evaluator.unregisterRule('rule_turbine_vibe');
  assert.equal(undeployed, true);
  assert.equal(evaluator.getActiveRules().length, 0);
  assert.equal(evaluator.getRule('rule_turbine_vibe'), null);
});

test('RuleEvaluator: triggers alert when telemetry exceeds threshold', () => {
  const evaluator = new RuleEvaluator();
  const rawRule = {
    id: 'rule_temp_critical',
    name: 'Core Temperature Monitor',
    nodes: [
      { id: 'src_temp', type: 'sourceNode', data: { category: 'source', deviceId: 'boiler-01', sensorType: 'temperature' } },
      { id: 'cond_temp', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 90 } },
      { id: 'act_sms', type: 'actionNode', data: { category: 'action', actionType: 'sms', target: '+919999999999', cooldownSeconds: 0 } },
    ],
    edges: [
      { id: 'e1', source: 'src_temp', target: 'cond_temp' },
      { id: 'e2', source: 'cond_temp', target: 'act_sms' },
    ],
  };

  evaluator.registerRule(defaultRuleParser.parse(rawRule));

  // Below threshold: Should not trigger alert
  const safeReading = {
    deviceId: 'boiler-01',
    sensorType: 'temperature',
    value: 75.5,
  };
  const safeResult = evaluator.evaluate(safeReading);
  assert.equal(safeResult.matchedRules, 1);
  assert.equal(safeResult.triggeredAlerts.length, 0);

  // Above threshold: Should trigger alert
  const breachReading = {
    deviceId: 'boiler-01',
    sensorType: 'temperature',
    value: 94.2,
  };
  const breachResult = evaluator.evaluate(breachReading);
  assert.equal(breachResult.matchedRules, 1);
  assert.equal(breachResult.triggeredAlerts.length, 1);

  const alert = breachResult.triggeredAlerts[0];
  assert.equal(alert.ruleId, 'rule_temp_critical');
  assert.equal(alert.actionType, 'sms');
  assert.equal(alert.value, 94.2);
  assert.equal(alert.target, '+919999999999');

  // Verify rule metrics updated
  const ruleData = evaluator.getRule('rule_temp_critical');
  assert.equal(ruleData.metrics.evaluationsCount, 2);
  assert.equal(ruleData.metrics.triggersCount, 1);
  assert.ok(ruleData.metrics.lastEvaluatedAt);
  assert.ok(ruleData.metrics.lastTriggeredAt);
});

test('RuleEvaluator: enforces action cooldown period', () => {
  const evaluator = new RuleEvaluator();
  const rawRule = {
    id: 'rule_cooldown_test',
    name: 'Cooldown Verification Rule',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'pump-01' } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>=', threshold: 50 } },
      { id: 'a1', type: 'actionNode', data: { category: 'action', actionType: 'webhook', cooldownSeconds: 60 } },
    ],
    edges: [
      { id: 'e1', source: 's1', target: 'c1' },
      { id: 'e2', source: 'c1', target: 'a1' },
    ],
  };

  evaluator.registerRule(defaultRuleParser.parse(rawRule));

  const reading = { deviceId: 'pump-01', value: 65 };

  // 1st evaluation triggers alert
  const res1 = evaluator.evaluate(reading);
  assert.equal(res1.triggeredAlerts.length, 1);

  // 2nd evaluation immediately after should be suppressed by cooldown
  const res2 = evaluator.evaluate(reading);
  assert.equal(res2.triggeredAlerts.length, 0);

  const stats = evaluator.getRule('rule_cooldown_test').metrics;
  assert.equal(stats.evaluationsCount, 2);
  assert.equal(stats.triggersCount, 1);
});

test('RuleEvaluator: supports range conditions (between and outside)', () => {
  const evaluator = new RuleEvaluator();
  const betweenRule = {
    id: 'rule_range_between',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'chamber-1' } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: 'between', min: 20, max: 30 } },
      { id: 'a1', type: 'actionNode', data: { category: 'action', cooldownSeconds: 0 } },
    ],
    edges: [
      { id: 'e1', source: 's1', target: 'c1' },
      { id: 'e2', source: 'c1', target: 'a1' },
    ],
  };

  evaluator.registerRule(defaultRuleParser.parse(betweenRule));

  assert.equal(evaluator.evaluate({ deviceId: 'chamber-1', value: 25 }).triggeredAlerts.length, 1);
  assert.equal(evaluator.evaluate({ deviceId: 'chamber-1', value: 35 }).triggeredAlerts.length, 0);
  assert.equal(evaluator.evaluate({ deviceId: 'chamber-1', value: 15 }).triggeredAlerts.length, 0);
});

test('RuleEvaluator: computes rolling moving average transforms', () => {
  const evaluator = new RuleEvaluator();
  const transformRule = {
    id: 'rule_moving_avg',
    name: 'Smoothed Anomaly Detector',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'motor-12' } },
      { id: 't1', type: 'transformNode', data: { category: 'transform', operation: 'moving-average', windowSize: 3 } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 100 } },
      { id: 'a1', type: 'actionNode', data: { category: 'action', cooldownSeconds: 0 } },
    ],
    edges: [
      { id: 'e1', source: 's1', target: 't1' },
      { id: 'e2', source: 't1', target: 'c1' },
      { id: 'e3', source: 'c1', target: 'a1' },
    ],
  };

  evaluator.registerRule(defaultRuleParser.parse(transformRule));

  // Feed 1: 90 -> buffer [90], avg = 90 (<= 100) -> no alert
  assert.equal(evaluator.evaluate({ deviceId: 'motor-12', value: 90 }).triggeredAlerts.length, 0);

  // Feed 2: 120 -> buffer [90, 120], avg = 105 (> 100) -> alert!
  const res2 = evaluator.evaluate({ deviceId: 'motor-12', value: 120 });
  assert.equal(res2.triggeredAlerts.length, 1);
  assert.equal(res2.triggeredAlerts[0].value, 105);

  // Feed 3: 80 -> buffer [90, 120, 80], avg = 96.67 (<= 100) -> no alert
  assert.equal(evaluator.evaluate({ deviceId: 'motor-12', value: 80 }).triggeredAlerts.length, 0);
});

test('RuleEvaluator: handles scale transform node', () => {
  const evaluator = new RuleEvaluator();
  const scaleRule = {
    id: 'rule_scale',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'solar-inv-1' } },
      { id: 't1', type: 'transformNode', data: { category: 'transform', operation: 'scale', factor: 0.1 } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 50 } },
      { id: 'a1', type: 'actionNode', data: { category: 'action', cooldownSeconds: 0 } },
    ],
    edges: [
      { id: 'e1', source: 's1', target: 't1' },
      { id: 'e2', source: 't1', target: 'c1' },
      { id: 'e3', source: 'c1', target: 'a1' },
    ],
  };

  evaluator.registerRule(defaultRuleParser.parse(scaleRule));

  // 400 * 0.1 = 40 (<= 50) -> no alert
  assert.equal(evaluator.evaluate({ deviceId: 'solar-inv-1', value: 400 }).triggeredAlerts.length, 0);

  // 600 * 0.1 = 60 (> 50) -> alert with evaluatedValue 60
  const res = evaluator.evaluate({ deviceId: 'solar-inv-1', value: 600 });
  assert.equal(res.triggeredAlerts.length, 1);
  assert.equal(res.triggeredAlerts[0].value, 60);
});

test('RuleEvaluator: dispatches to multiple actions in multi-branch topologies', () => {
  const evaluator = new RuleEvaluator();
  const multiBranch = {
    id: 'rule_multi_action',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'reactor-01' } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 100 } },
      { id: 'act_sms', type: 'actionNode', data: { category: 'action', actionType: 'sms', cooldownSeconds: 0 } },
      { id: 'act_webhook', type: 'actionNode', data: { category: 'action', actionType: 'webhook', cooldownSeconds: 0 } },
    ],
    edges: [
      { id: 'e1', source: 's1', target: 'c1' },
      { id: 'e2', source: 'c1', target: 'act_sms' },
      { id: 'e3', source: 'c1', target: 'act_webhook' },
    ],
  };

  evaluator.registerRule(defaultRuleParser.parse(multiBranch));

  const res = evaluator.evaluate({ deviceId: 'reactor-01', value: 105 });
  assert.equal(res.triggeredAlerts.length, 2);
  const types = res.triggeredAlerts.map((a) => a.actionType);
  assert.ok(types.includes('sms'));
  assert.ok(types.includes('webhook'));
});

test('RuleEvaluator: skips evaluation when deviceId does not match rule source', () => {
  const evaluator = new RuleEvaluator();
  const rule = {
    id: 'rule_specific_dev',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'device-alpha' } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 10 } },
      { id: 'a1', type: 'actionNode', data: { category: 'action', cooldownSeconds: 0 } },
    ],
    edges: [
      { id: 'e1', source: 's1', target: 'c1' },
      { id: 'e2', source: 'c1', target: 'a1' },
    ],
  };

  evaluator.registerRule(defaultRuleParser.parse(rule));

  const res = evaluator.evaluate({ deviceId: 'device-bravo', value: 999 });
  assert.equal(res.matchedRules, 0);
  assert.equal(res.triggeredAlerts.length, 0);
});

test('RuleEvaluator: invokes custom onAlert callback and returns diagnostic timings', () => {
  const receivedAlerts = [];
  const evaluator = new RuleEvaluator({
    onAlert: (alert) => receivedAlerts.push(alert),
  });

  const rule = {
    id: 'rule_callback_test',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'all' } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>=', threshold: 0 } },
      { id: 'a1', type: 'actionNode', data: { category: 'action', cooldownSeconds: 0 } },
    ],
    edges: [
      { id: 'e1', source: 's1', target: 'c1' },
      { id: 'e2', source: 'c1', target: 'a1' },
    ],
  };

  evaluator.registerRule(defaultRuleParser.parse(rule));

  const result = evaluator.evaluate({ deviceId: 'test-device', value: 10 });
  assert.equal(result.triggeredAlerts.length, 1);
  assert.equal(receivedAlerts.length, 1);
  assert.equal(receivedAlerts[0].deviceId, 'test-device');
  assert.equal(typeof result.totalExecutionTimeMs, 'number');
});
