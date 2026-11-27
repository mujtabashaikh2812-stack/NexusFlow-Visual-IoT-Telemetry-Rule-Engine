'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { io: ClientIO } = require('socket.io-client');
const { server, defaultRateLimiter } = require('../../src/server');
const { defaultRuleEvaluator } = require('../../src/core/ruleEvaluator');
const { defaultRuleStore } = require('../../src/core/ruleStore');
const { defaultConnectionRegistry } = require('../../src/core/connectionRegistry');

/**
 * Cross-Pod Integration Checkpoint 2 (Akhila's React Flow Visual Canvas -> Live Rule Engine)
 * Verifies end-to-end visual graph serialization, topological compilation, live deployment,
 * hot-reload WebSocket notifications, and real-time `rule:triggered` glowing-wire events.
 */

let serverInstance = null;
let baseUrl = '';
let wsPort = 0;

function httpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = payload
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      : {};

    const req = http.request(`${baseUrl}${path}`, { method, headers }, (res) => {
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
    if (payload) req.write(payload);
    req.end();
  });
}

test.before(async () => {
  defaultRateLimiter.reset();
  defaultConnectionRegistry.clear();
  await new Promise((resolve) => {
    serverInstance = server.listen(0, '127.0.0.1', () => {
      wsPort = serverInstance.address().port;
      baseUrl = `http://127.0.0.1:${wsPort}`;
      resolve();
    });
  });
});

test.after(async () => {
  defaultRuleEvaluator.unregisterRule('canvas_turbine_protection');
  defaultRuleStore.deleteRule('canvas_turbine_protection');
  defaultRateLimiter.reset();
  defaultConnectionRegistry.clear();
  if (serverInstance) {
    await new Promise((resolve) => serverInstance.close(resolve));
  }
});

test('Integration Checkpoint 2: React Flow canvas JSON -> AST compile -> deploy -> WebSocket glowing wire events', async () => {
  // Complex multi-branch visual canvas exported from React Flow
  const canvasGraph = {
    id: 'canvas_turbine_protection',
    name: 'Visual Studio: Turbine Temp AND Vibration Safety Net',
    nodes: [
      {
        id: 'node_src_temp',
        type: 'sourceNode',
        position: { x: 50, y: 50 },
        data: { deviceId: 'turbine-canvas-01', sensorType: 'temperature', label: 'Turbine Core Temp' },
      },
      {
        id: 'node_src_vib',
        type: 'sourceNode',
        position: { x: 50, y: 220 },
        data: { deviceId: 'turbine-canvas-01', sensorType: 'vibration', label: 'Shaft Vibration' },
      },
      {
        id: 'node_avg_temp',
        type: 'transformNode',
        position: { x: 260, y: 50 },
        data: { operation: 'moving-average', windowSize: 2, label: '2-Sample Avg' },
      },
      {
        id: 'node_fsm_temp',
        type: 'stateMachineNode',
        position: { x: 470, y: 50 },
        data: {
          warningThreshold: 75,
          criticalThreshold: 90,
          hysteresis: 5,
          criticalDebounceCount: 1,
          triggerStates: ['CRITICAL'],
        },
      },
      {
        id: 'node_cond_vib',
        type: 'conditionNode',
        position: { x: 470, y: 220 },
        data: { operator: '>', threshold: 10 },
      },
      {
        id: 'node_logic_and',
        type: 'logicNode',
        position: { x: 700, y: 135 },
        data: { operator: 'AND', windowMs: 60000 },
      },
      {
        id: 'node_action_glow',
        type: 'actionNode',
        position: { x: 920, y: 135 },
        data: {
          actionType: 'alert',
          priority: 'critical',
          cooldownSeconds: 0,
          template: 'CRITICAL SAFETY BREACH on {deviceId}: composite anomaly active',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'node_src_temp', target: 'node_avg_temp' },
      { id: 'e2', source: 'node_avg_temp', target: 'node_fsm_temp' },
      { id: 'e3', source: 'node_fsm_temp', target: 'node_logic_and' },
      { id: 'e4', source: 'node_src_vib', target: 'node_cond_vib' },
      { id: 'e5', source: 'node_cond_vib', target: 'node_logic_and' },
      { id: 'e6', source: 'node_logic_and', target: 'node_action_glow' },
    ],
  };

  // 1. Validate raw canvas graph
  const validateRes = await httpRequest('POST', '/api/rules/validate', canvasGraph);
  assert.equal(validateRes.status, 200);
  assert.equal(validateRes.data.valid, true);
  assert.equal(validateRes.data.metadata.topology, 'multi-branch');

  // 2. Compile topological execution plan
  const compileRes = await httpRequest('POST', '/api/rules/compile', canvasGraph);
  assert.equal(compileRes.status, 200);
  assert.equal(compileRes.data.ast.pipeline.stateMachines.length, 1);
  assert.equal(compileRes.data.ast.pipeline.logics.length, 1);

  const plan = compileRes.data.ast.executionPlan;
  assert.ok(plan.indexOf('node_avg_temp') < plan.indexOf('node_fsm_temp'));
  assert.ok(plan.indexOf('node_fsm_temp') < plan.indexOf('node_logic_and'));
  assert.ok(plan.indexOf('node_logic_and') < plan.indexOf('node_action_glow'));

  // 3. Deploy to live engine
  const deployRes = await httpRequest('POST', '/api/rules/deploy', canvasGraph);
  assert.equal(deployRes.status, 201);
  assert.equal(deployRes.data.ruleId, 'canvas_turbine_protection');

  // 4. Connect UI client over WebSocket to listen for glowing-wire events
  const uiSocket = ClientIO(`http://127.0.0.1:${wsPort}`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });

  const receivedTelemetry = [];
  const receivedTriggers = [];
  const receivedReloads = [];

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('UI WebSocket join timeout')), 4000);
      uiSocket.on('connect', () => {
        uiSocket.emit('client:join', { username: 'UI-Canvas-Akhila', role: 'operator' });
      });
      uiSocket.on('client:joined', () => {
        uiSocket.emit('rule:subscribe', 'canvas_turbine_protection');
      });
      uiSocket.on('rule:subscribed', () => {
        clearTimeout(t);
        resolve();
      });
    });

    uiSocket.on('telemetry:stream', (evt) => receivedTelemetry.push(evt));
    uiSocket.on('rule:triggered', (evt) => receivedTriggers.push(evt));
    uiSocket.on('rule:reloaded', (evt) => receivedReloads.push(evt));

    // Branch A (Temperature): send 95 -> avg=95 -> FSM enters CRITICAL
    await httpRequest('POST', '/api/telemetry/ingest', {
      deviceId: 'turbine-canvas-01',
      sensorType: 'temperature',
      value: 95,
    });

    // Only Branch A is critical, Branch B (vibration) not yet high -> NO alert yet!
    assert.equal(receivedTriggers.length, 0);

    // Branch B (Vibration): send 14.5 > 10 -> AND gate satisfies -> glowing-wire rule:triggered fires!
    const triggerPromise = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Expected rule:triggered event timeout')), 4000);
      uiSocket.once('rule:triggered', (alert) => {
        clearTimeout(t);
        resolve(alert);
      });
    });

    await httpRequest('POST', '/api/telemetry/ingest', {
      deviceId: 'turbine-canvas-01',
      sensorType: 'vibration',
      value: 14.5,
    });

    const firedAlert = await triggerPromise;
    assert.equal(firedAlert.ruleId, 'canvas_turbine_protection');
    assert.ok(receivedTelemetry.length >= 2);

    // 5. Hot-reload visual canvas rule (tweak vibration threshold 10 -> 8) & verify rule:reloaded broadcast
    canvasGraph.nodes[4].data.threshold = 8;
    const reloadPromise = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Expected rule:reloaded event timeout')), 4000);
      uiSocket.once('rule:reloaded', (evt) => {
        clearTimeout(t);
        resolve(evt);
      });
    });

    const reloadRes = await httpRequest('PUT', '/api/rules/canvas_turbine_protection', canvasGraph);
    assert.equal(reloadRes.status, 200);
    assert.equal(reloadRes.data.status, 'reloaded');
    assert.ok(reloadRes.data.preservedBufferCount > 0);

    const reloadEvt = await reloadPromise;
    assert.equal(reloadEvt.ruleId, 'canvas_turbine_protection');
    assert.ok(receivedReloads.length === 1);
  } finally {
    uiSocket.disconnect();
  }
});
