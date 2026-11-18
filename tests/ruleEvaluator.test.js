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

test('RuleEvaluator: evaluates composite AND logic gate across multiple conditions', () => {
  const evaluator = new RuleEvaluator();
  const rule = {
    id: 'rule_composite_and',
    name: 'Dual Condition Range Guard',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'turbine-omega' } },
      { id: 'c_min', type: 'conditionNode', data: { category: 'condition', operator: '>=', threshold: 40 } },
      { id: 'c_max', type: 'conditionNode', data: { category: 'condition', operator: '<=', threshold: 80 } },
      { id: 'gate_and', type: 'logicNode', data: { category: 'logic', operator: 'AND', windowMs: 10000 } },
      { id: 'act_safe', type: 'actionNode', data: { category: 'action', actionType: 'alert', cooldownSeconds: 0 } },
    ],
    edges: [
      { id: 'e1', source: 's1', target: 'c_min' },
      { id: 'e2', source: 's1', target: 'c_max' },
      { id: 'e3', source: 'c_min', target: 'gate_and' },
      { id: 'e4', source: 'c_max', target: 'gate_and' },
      { id: 'e5', source: 'gate_and', target: 'act_safe' },
    ],
  };

  evaluator.registerRule(defaultRuleParser.parse(rule));

  // Value 60: >= 40 AND <= 80 -> TRUE
  const res1 = evaluator.evaluate({ deviceId: 'turbine-omega', value: 60 });
  assert.equal(res1.triggeredAlerts.length, 1);

  // Value 90: >= 40 (true) but <= 80 (false) -> AND fails -> FALSE
  const res2 = evaluator.evaluate({ deviceId: 'turbine-omega', value: 90 });
  assert.equal(res2.triggeredAlerts.length, 0);

  // Value 20: >= 40 (false) -> AND fails -> FALSE
  const res3 = evaluator.evaluate({ deviceId: 'turbine-omega', value: 20 });
  assert.equal(res3.triggeredAlerts.length, 0);
});

test('RuleEvaluator: evaluates composite OR logic gate across branching conditions', () => {
  const evaluator = new RuleEvaluator();
  const rule = {
    id: 'rule_composite_or',
    name: 'Critical Extreme Hazard Alarm',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'boiler-99' } },
      { id: 'c_extreme_low', type: 'conditionNode', data: { category: 'condition', operator: '<', threshold: 10 } },
      { id: 'c_extreme_high', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 120 } },
      { id: 'gate_or', type: 'logicNode', data: { category: 'logic', operator: 'OR' } },
      { id: 'act_alarm', type: 'actionNode', data: { category: 'action', actionType: 'sms', cooldownSeconds: 0 } },
    ],
    edges: [
      { id: 'e1', source: 's1', target: 'c_extreme_low' },
      { id: 'e2', source: 's1', target: 'c_extreme_high' },
      { id: 'e3', source: 'c_extreme_low', target: 'gate_or' },
      { id: 'e4', source: 'c_extreme_high', target: 'gate_or' },
      { id: 'e5', source: 'gate_or', target: 'act_alarm' },
    ],
  };

  evaluator.registerRule(defaultRuleParser.parse(rule));

  // 130 > 120 -> OR passes -> Alarm triggers
  assert.equal(evaluator.evaluate({ deviceId: 'boiler-99', value: 130 }).triggeredAlerts.length, 1);

  // 5 < 10 -> OR passes -> Alarm triggers
  assert.equal(evaluator.evaluate({ deviceId: 'boiler-99', value: 5 }).triggeredAlerts.length, 1);

  // 50 (normal operating range) -> OR fails -> No alarm
  assert.equal(evaluator.evaluate({ deviceId: 'boiler-99', value: 50 }).triggeredAlerts.length, 0);
});

test('RuleEvaluator: evaluates asynchronous multi-sensor composite conditions across telemetry events', () => {
  const evaluator = new RuleEvaluator();
  const rule = {
    id: 'rule_dual_sensor_hazard',
    name: 'Turbine Dual Sensor Hazard',
    nodes: [
      { id: 's_temp', type: 'sourceNode', data: { category: 'source', deviceId: 'turbine-core', sensorType: 'temp' } },
      { id: 's_vibe', type: 'sourceNode', data: { category: 'source', deviceId: 'turbine-core', sensorType: 'vibe' } },
      { id: 'c_temp', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 85 } },
      { id: 'c_vibe', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 12 } },
      { id: 'gate_and', type: 'logicNode', data: { category: 'logic', operator: 'AND', windowMs: 15000 } },
      { id: 'act_emergency', type: 'actionNode', data: { category: 'action', actionType: 'webhook', cooldownSeconds: 0 } },
    ],
    edges: [
      { id: 'e1', source: 's_temp', target: 'c_temp' },
      { id: 'e2', source: 's_vibe', target: 'c_vibe' },
      { id: 'e3', source: 'c_temp', target: 'gate_and' },
      { id: 'e4', source: 'c_vibe', target: 'gate_and' },
      { id: 'e5', source: 'gate_and', target: 'act_emergency' },
    ],
  };

  evaluator.registerRule(defaultRuleParser.parse(rule));

  // Step 1: Temp event arrives at 92°C (> 85, TRUE). But vibration has not arrived yet.
  const step1 = evaluator.evaluate({ deviceId: 'turbine-core', sensorType: 'temp', value: 92 });
  assert.equal(step1.matchedRules, 1);
  assert.equal(step1.triggeredAlerts.length, 0); // Vibe is missing, so AND fails

  // Step 2: Vibe event arrives at 16 (> 12, TRUE). Temp was cached and within 15s window -> BOTH TRUE!
  const step2 = evaluator.evaluate({ deviceId: 'turbine-core', sensorType: 'vibe', value: 16 });
  assert.equal(step2.matchedRules, 1);
  assert.equal(step2.triggeredAlerts.length, 1);
  assert.equal(step2.triggeredAlerts[0].ruleId, 'rule_dual_sensor_hazard');
});

test('RuleEvaluator: executes rate-of-change (derivative) pipeline for predictive early warning', () => {
  const evaluator = new RuleEvaluator();
  const rule = {
    id: 'rule_thermal_runaway',
    name: 'Thermal Runaway Early Warning',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'boiler-thermal' } },
      { id: 'tf_rate', type: 'transformNode', data: { category: 'transform', operation: 'derivative', timeUnit: 'per_second' } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 5 } }, // > 5 deg/s rate of change
      { id: 'act_warn', type: 'actionNode', data: { category: 'action', actionType: 'sms', cooldownSeconds: 0 } },
    ],
    edges: [
      { id: 'e1', source: 's1', target: 'tf_rate' },
      { id: 'e2', source: 'tf_rate', target: 'c1' },
      { id: 'e3', source: 'c1', target: 'act_warn' },
    ],
  };

  evaluator.registerRule(defaultRuleParser.parse(rule));

  const t0 = 1700000000000;

  // Reading 1: Baseline at 50 degC (derivative = 0)
  const r1 = evaluator.evaluate({ deviceId: 'boiler-thermal', value: 50, timestamp: new Date(t0).toISOString() });
  assert.equal(r1.triggeredAlerts.length, 0);

  // Reading 2: Normal slow heating: 52 degC at t0 + 2000ms (+2 in 2s -> 1 deg/s <= 5)
  const r2 = evaluator.evaluate({ deviceId: 'boiler-thermal', value: 52, timestamp: new Date(t0 + 2000).toISOString() });
  assert.equal(r2.triggeredAlerts.length, 0);

  // Reading 3: Thermal runaway spike: 70 degC at t0 + 4000ms (+18 in 2s -> 9 deg/s > 5) -> Early warning triggers!
  const r3 = evaluator.evaluate({ deviceId: 'boiler-thermal', value: 70, timestamp: new Date(t0 + 4000).toISOString() });
  assert.equal(r3.triggeredAlerts.length, 1);
  assert.equal(r3.triggeredAlerts[0].ruleId, 'rule_thermal_runaway');
  assert.equal(r3.triggeredAlerts[0].value, 9);
});
