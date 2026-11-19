'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { app } = require('../src/server');
const { RuleEvaluator } = require('../src/core/ruleEvaluator');
const { defaultRuleReloader } = require('../src/core/ruleReloader');
const { defaultRuleParser } = require('../src/core/ruleParser');

let testServer = null;
let basePort = 49300 + Math.floor(Math.random() * 500);
let baseUrl = `http://127.0.0.1:${basePort}`;

test.before(async () => {
  await new Promise((resolve) => {
    testServer = app.listen(basePort, () => resolve());
  });
});

test.after(async () => {
  if (testServer) {
    await new Promise((resolve) => testServer.close(resolve));
  }
});

function httpPut(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`${baseUrl}${path}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpDelete(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, {
      method: 'DELETE',
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('RuleReloader: computes accurate semantic AST diffs (add, remove, modify)', () => {
  const oldGraph = {
    id: 'rule_diff_test',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'pump-1' } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 50 } },
      { id: 'a1', type: 'actionNode', data: { category: 'action', actionType: 'sms' } },
    ],
    edges: [
      { source: 's1', target: 'c1' },
      { source: 'c1', target: 'a1' },
    ],
  };

  const newGraph = {
    id: 'rule_diff_test',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'pump-1' } },
      { id: 'tf_avg', type: 'transformNode', data: { category: 'transform', operation: 'moving-average', windowSize: 5 } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>=', threshold: 75 } }, // modified
      // a1 removed, replaced with a2
      { id: 'a2', type: 'actionNode', data: { category: 'action', actionType: 'webhook' } },
    ],
    edges: [
      { source: 's1', target: 'tf_avg' },
      { source: 'tf_avg', target: 'c1' },
      { source: 'c1', target: 'a2' },
    ],
  };

  const oldAst = defaultRuleParser.parse(oldGraph);
  const newAst = defaultRuleParser.parse(newGraph);

  const diff = defaultRuleReloader.diffRules(oldAst, newAst);

  assert.equal(diff.hasChanges, true);
  assert.equal(diff.topologyChanged, true);

  // Added nodes: tf_avg, a2
  assert.equal(diff.nodes.added.length, 2);
  assert.ok(diff.nodes.added.some((n) => n.id === 'tf_avg'));
  assert.ok(diff.nodes.added.some((n) => n.id === 'a2'));

  // Removed nodes: a1
  assert.equal(diff.nodes.removed.length, 1);
  assert.equal(diff.nodes.removed[0].id, 'a1');

  // Modified nodes: c1 (threshold changed from 50 to 75, operator > to >=)
  assert.equal(diff.nodes.modified.length, 1);
  assert.equal(diff.nodes.modified[0].id, 'c1');
  assert.equal(diff.nodes.modified[0].changes.threshold.from, 50);
  assert.equal(diff.nodes.modified[0].changes.threshold.to, 75);

  // Retained nodes: s1
  assert.equal(diff.nodes.retained.length, 1);
  assert.equal(diff.nodes.retained[0].id, 's1');
});

test('RuleEvaluator: hotReloadRule preserves rolling moving-average buffer', () => {
  const evaluator = new RuleEvaluator();
  const v1 = {
    id: 'rule_reload_mavg',
    name: 'Moving Average V1',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'turbine-X' } },
      { id: 'tf_avg', type: 'transformNode', data: { category: 'transform', operation: 'moving-average', windowSize: 5 } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 100 } },
      { id: 'a1', type: 'actionNode', data: { category: 'action', actionType: 'alert', cooldownSeconds: 0 } },
    ],
    edges: [
      { source: 's1', target: 'tf_avg' },
      { source: 'tf_avg', target: 'c1' },
      { source: 'c1', target: 'a1' },
    ],
  };

  evaluator.registerRule(defaultRuleParser.parse(v1));

  // Feed 2 readings to build up the buffer: 60, 80 (avg = 70 <= 100)
  evaluator.evaluate({ deviceId: 'turbine-X', value: 60 });
  evaluator.evaluate({ deviceId: 'turbine-X', value: 80 });

  // Update rule V2: lower threshold to 70 (avg of [60, 80, 80] = 73.3 > 70)
  const v2 = {
    id: 'rule_reload_mavg',
    name: 'Moving Average V2 (Tightened)',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'turbine-X' } },
      { id: 'tf_avg', type: 'transformNode', data: { category: 'transform', operation: 'moving-average', windowSize: 5 } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 70 } }, // changed 100 -> 70
      { id: 'a1', type: 'actionNode', data: { category: 'action', actionType: 'alert', cooldownSeconds: 0 } },
    ],
    edges: [
      { source: 's1', target: 'tf_avg' },
      { source: 'tf_avg', target: 'c1' },
      { source: 'c1', target: 'a1' },
    ],
  };

  const reloadResult = evaluator.hotReloadRule(defaultRuleParser.parse(v2), { preserveState: true });
  assert.equal(reloadResult.status, 'reloaded');
  assert.equal(reloadResult.reloadsCount, 1);
  assert.ok(reloadResult.preservedBufferCount >= 1);

  // Feed 3rd reading: 80. Buffer should have [60, 80, 80] with avg 73.33 > 70 -> Alert triggers!
  const res3 = evaluator.evaluate({ deviceId: 'turbine-X', value: 80 });
  assert.equal(res3.triggeredAlerts.length, 1);
  assert.equal(res3.triggeredAlerts[0].value, 73.33);
});

test('RuleEvaluator: hotReloadRule preserves action cooldown timestamps to prevent alert storms', () => {
  const evaluator = new RuleEvaluator();
  const v1 = {
    id: 'rule_cooldown_reload',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'sensor-cooldown' } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 50 } },
      { id: 'a1', type: 'actionNode', data: { category: 'action', actionType: 'sms', cooldownSeconds: 60 } },
    ],
    edges: [
      { source: 's1', target: 'c1' },
      { source: 'c1', target: 'a1' },
    ],
  };

  evaluator.registerRule(defaultRuleParser.parse(v1));

  // Trigger alert
  const res1 = evaluator.evaluate({ deviceId: 'sensor-cooldown', value: 90 });
  assert.equal(res1.triggeredAlerts.length, 1);

  // Hot-reload rule with modified condition threshold
  const v2 = {
    ...v1,
    nodes: [
      v1.nodes[0],
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 40 } },
      v1.nodes[2],
    ],
  };

  evaluator.hotReloadRule(defaultRuleParser.parse(v2), { preserveState: true });

  // Immediate subsequent breach must be suppressed by preserved cooldown timer
  const res2 = evaluator.evaluate({ deviceId: 'sensor-cooldown', value: 90 });
  assert.equal(res2.triggeredAlerts.length, 0);
});

test('PUT /api/rules/:ruleId: hot-reloads rule via REST and preserves buffers', async () => {
  const initialRule = {
    id: 'rule_rest_hot_reload',
    name: 'Initial REST Rule',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'motor-reload' } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 80 } },
      { id: 'a1', type: 'actionNode', data: { category: 'action', actionType: 'sms', cooldownSeconds: 0 } },
    ],
    edges: [
      { source: 's1', target: 'c1' },
      { source: 'c1', target: 'a1' },
    ],
  };

  // Deploy initial rule
  const deployRes = await httpPost('/api/rules/deploy', initialRule);
  assert.equal(deployRes.status, 201);

  // Update rule with new threshold (60)
  const updatedRule = {
    ...initialRule,
    name: 'Updated REST Rule',
    nodes: [
      initialRule.nodes[0],
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 60 } },
      initialRule.nodes[2],
    ],
  };

  // Pre-flight diff check
  const diffRes = await httpPost('/api/rules/rule_rest_hot_reload/diff', updatedRule);
  assert.equal(diffRes.status, 200);
  assert.equal(diffRes.data.diff.hasChanges, true);
  assert.equal(diffRes.data.diff.nodes.modified.length, 1);

  // Execute live hot-reload
  const reloadRes = await httpPut('/api/rules/rule_rest_hot_reload', updatedRule);
  assert.equal(reloadRes.status, 200);
  assert.equal(reloadRes.data.status, 'reloaded');
  assert.equal(reloadRes.data.reloadsCount, 1);
  assert.equal(reloadRes.data.persisted, true);

  // Test live evaluation with new threshold (value 70 > 60 triggers alert)
  const evalRes = await httpPost('/api/telemetry/ingest', {
    deviceId: 'motor-reload',
    value: 70,
  });
  assert.equal(evalRes.status, 202);
  assert.equal(evalRes.data.evaluation.alertsTriggered, 1);

  // Clean up
  await httpDelete('/api/rules/rule_rest_hot_reload');
});

test('Middleware: validateRulePayload rejects malformed graphs or cycles', async () => {
  // Empty graph
  const emptyRes = await httpPost('/api/rules/deploy', { nodes: [] });
  assert.equal(emptyRes.status, 400);
  assert.equal(emptyRes.data.error, 'EMPTY_GRAPH');

  // Missing nodes
  const missingRes = await httpPost('/api/rules/deploy', { edges: [] });
  assert.equal(missingRes.status, 400);
  assert.equal(missingRes.data.error, 'MISSING_NODES');

  // Cyclic graph
  const cyclicGraph = {
    id: 'rule_cycle_rejection',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source' } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition' } },
      { id: 't1', type: 'transformNode', data: { category: 'transform' } },
      { id: 'a1', type: 'actionNode', data: { category: 'action' } },
    ],
    edges: [
      { source: 's1', target: 'c1' },
      { source: 'c1', target: 't1' },
      { source: 't1', target: 'c1' }, // cycle!
      { source: 't1', target: 'a1' },
    ],
  };

  const cycleRes = await httpPost('/api/rules/deploy', cyclicGraph);
  assert.equal(cycleRes.status, 400);
  assert.equal(cycleRes.data.error, 'CYCLE_DETECTED');
});
