'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FSM_STATES, StateMachineEngine } = require('../src/core/stateMachine');
const { defaultRuleParser, NODE_CATEGORIES } = require('../src/core/ruleParser');
const { RuleEvaluator } = require('../src/core/ruleEvaluator');

test('StateMachineEngine: transitions smoothly across IDLE -> WARNING -> CRITICAL -> RECOVERY -> IDLE', () => {
  const fsm = new StateMachineEngine();
  const cfg = {
    warningThreshold: 70,
    criticalThreshold: 90,
    hysteresis: 5, // recoveryThreshold = 65
    warningDebounceCount: 1,
    criticalDebounceCount: 2,
    recoverySamplesCount: 2,
    triggerStates: ['CRITICAL'],
  };

  // 1. Baseline safe reading -> IDLE
  let r = fsm.evaluate('fsm-1', 'turbine-01', 50, cfg);
  assert.equal(r.currentState, FSM_STATES.IDLE);
  assert.equal(r.isTriggered, false);
  assert.equal(r.transitioned, false);

  // 2. Breaches warning threshold -> WARNING (not yet triggered since triggerStates=['CRITICAL'])
  r = fsm.evaluate('fsm-1', 'turbine-01', 75, cfg);
  assert.equal(r.previousState, FSM_STATES.IDLE);
  assert.equal(r.currentState, FSM_STATES.WARNING);
  assert.equal(r.transitioned, true);
  assert.equal(r.isTriggered, false);

  // 3. First critical spike -> still WARNING due to criticalDebounceCount=2
  r = fsm.evaluate('fsm-1', 'turbine-01', 92, cfg);
  assert.equal(r.currentState, FSM_STATES.WARNING);
  assert.equal(r.consecutiveCritical, 1);
  assert.equal(r.isTriggered, false);

  // 4. Second consecutive critical spike -> CRITICAL & triggered
  r = fsm.evaluate('fsm-1', 'turbine-01', 95, cfg);
  assert.equal(r.previousState, FSM_STATES.WARNING);
  assert.equal(r.currentState, FSM_STATES.CRITICAL);
  assert.equal(r.transitioned, true);
  assert.equal(r.isTriggered, true);

  // 5. Drops into hysteresis deadband (65 <= 68 < 70): remains CRITICAL (no flapping)
  r = fsm.evaluate('fsm-1', 'turbine-01', 68, cfg);
  assert.equal(r.zone, 'DEADBAND');
  assert.equal(r.currentState, FSM_STATES.CRITICAL);
  assert.equal(r.isTriggered, true);

  // 6. First safe reading below 65 -> RECOVERY
  r = fsm.evaluate('fsm-1', 'turbine-01', 60, cfg);
  assert.equal(r.previousState, FSM_STATES.CRITICAL);
  assert.equal(r.currentState, FSM_STATES.RECOVERY);
  assert.equal(r.transitioned, true);
  assert.equal(r.isTriggered, false);

  // 7. Second consecutive safe reading -> IDLE
  r = fsm.evaluate('fsm-1', 'turbine-01', 58, cfg);
  assert.equal(r.previousState, FSM_STATES.RECOVERY);
  assert.equal(r.currentState, FSM_STATES.IDLE);
  assert.equal(r.transitioned, true);

  const snapshot = fsm.getMachineState('fsm-1', 'turbine-01');
  assert.equal(snapshot.transitionHistory.length, 4);
});

test('StateMachineEngine: supports lower-bound (lt) monitoring for battery voltage / pressure drop', () => {
  const fsm = new StateMachineEngine();
  const cfg = {
    comparator: 'lt',
    warningThreshold: 25,
    criticalThreshold: 15,
    hysteresis: 5, // recoveryThreshold = 30
    warningDebounceCount: 1,
    criticalDebounceCount: 1,
    recoverySamplesCount: 1,
    triggerStates: ['WARNING', 'CRITICAL'],
  };

  assert.equal(fsm.evaluate('fsm-batt', 'sensor-a', 40, cfg).currentState, FSM_STATES.IDLE);

  const warn = fsm.evaluate('fsm-batt', 'sensor-a', 22, cfg);
  assert.equal(warn.currentState, FSM_STATES.WARNING);
  assert.equal(warn.isTriggered, true);

  const crit = fsm.evaluate('fsm-batt', 'sensor-a', 12, cfg);
  assert.equal(crit.currentState, FSM_STATES.CRITICAL);
  assert.equal(crit.isTriggered, true);

  // In deadband (25 < 28 <= 30) -> stays CRITICAL
  assert.equal(fsm.evaluate('fsm-batt', 'sensor-a', 28, cfg).currentState, FSM_STATES.CRITICAL);

  // Above recoveryThreshold (35 > 30) -> recovers to IDLE
  const rec = fsm.evaluate('fsm-batt', 'sensor-a', 35, cfg);
  assert.equal(rec.currentState, FSM_STATES.IDLE);
  assert.equal(rec.isTriggered, false);
});

test('StateMachineEngine: isolates states across different entities and devices', () => {
  const fsm = new StateMachineEngine();
  const cfg = { criticalThreshold: 80, criticalDebounceCount: 1, warningThreshold: 70 };

  fsm.evaluate('fsm-node', 'device-A', 85, cfg);
  fsm.evaluate('fsm-node', 'device-B', 50, cfg);

  assert.equal(fsm.getMachineState('fsm-node', 'device-A').currentState, FSM_STATES.CRITICAL);
  assert.equal(fsm.getMachineState('fsm-node', 'device-B').currentState, FSM_STATES.IDLE);

  fsm.reset('fsm-node', 'device-A');
  assert.equal(fsm.getMachineState('fsm-node', 'device-A'), null);
  assert.equal(fsm.getMachineState('fsm-node', 'device-B').currentState, FSM_STATES.IDLE);
});

test('RuleParser & RuleEvaluator: compiles and executes stateMachineNode in live pipeline', () => {
  const graph = {
    id: 'rule_fsm_turbine',
    name: 'Anti-Flapping Turbine Overheat FSM',
    nodes: [
      { id: 'src1', type: 'sourceNode', data: { deviceId: 'turbine-99', sensorType: 'temperature' } },
      {
        id: 'fsm1',
        type: 'stateMachineNode',
        data: {
          warningThreshold: 75,
          criticalThreshold: 95,
          hysteresis: 5,
          warningDebounceCount: 1,
          criticalDebounceCount: 2,
          recoverySamplesCount: 2,
          triggerStates: ['CRITICAL'],
        },
      },
      {
        id: 'act1',
        type: 'actionNode',
        data: {
          actionType: 'alert',
          priority: 'high',
          cooldownSeconds: 0,
          template: 'FSM CRITICAL on {deviceId}: {value}C',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'src1', target: 'fsm1' },
      { id: 'e2', source: 'fsm1', target: 'act1' },
    ],
  };

  const ast = defaultRuleParser.parse(graph);
  assert.equal(ast.pipeline.stateMachines.length, 1);
  assert.equal(ast.pipeline.stateMachines[0].category, NODE_CATEGORIES.STATE_MACHINE);

  const evaluator = new RuleEvaluator();
  evaluator.registerRule(ast);

  // Sample 1: Warning (no action)
  let res = evaluator.evaluate({ deviceId: 'turbine-99', sensorType: 'temperature', value: 80 });
  assert.equal(res.triggeredAlerts.length, 0);

  // Sample 2: First critical spike (debounced, no action yet)
  res = evaluator.evaluate({ deviceId: 'turbine-99', sensorType: 'temperature', value: 96 });
  assert.equal(res.triggeredAlerts.length, 0);

  // Sample 3: Second consecutive critical spike -> FSM CRITICAL -> Alert triggers!
  res = evaluator.evaluate({ deviceId: 'turbine-99', sensorType: 'temperature', value: 98 });
  assert.equal(res.triggeredAlerts.length, 1);
  assert.ok(res.triggeredAlerts[0].message.includes('FSM CRITICAL on turbine-99: 98C'));
});
