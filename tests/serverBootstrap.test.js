'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const config = require('../src/config/serverConfig');
const { app } = require('../src/server');

let testServer = null;
let basePort = 49152 + Math.floor(Math.random() * 1000);
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

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers });
        } catch (_) {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    }).on('error', reject);
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
          resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers });
        } catch (_) {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('serverConfig: loads sensible defaults for port, host, and origins', () => {
  assert.equal(typeof config.port, 'number');
  assert.equal(typeof config.host, 'string');
  assert.equal(Array.isArray(config.clientOrigins), true);
  assert.equal(config.clientOrigins.length > 0, true);
  assert.equal(typeof config.isProduction(), 'boolean');
  assert.equal(typeof config.isDevelopment(), 'boolean');
});

test('GET /api/health: returns healthy status with subsystem diagnostics', async () => {
  const res = await httpGet('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'healthy');
  assert.equal(res.data.version, '1.0.0');
  assert.equal(typeof res.data.uptimeSeconds, 'number');
  assert.equal(res.data.subsystems.httpServer, 'online');
  assert.equal(res.data.subsystems.socketEngine, 'online');
  assert.equal(res.data.subsystems.connectionRegistry, 'online');
});

test('GET /healthz: provides identical health contract for cloud probes', async () => {
  const res = await httpGet('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'healthy');
});

test('GET /api/system/stats: returns active connection tallies', async () => {
  const res = await httpGet('/api/system/stats');
  assert.equal(res.status, 200);
  assert.equal(typeof res.data.activeClients, 'number');
  assert.equal(typeof res.data.activeDevices, 'number');
  assert.equal(typeof res.data.totalConnections, 'number');
});

test('GET /api/devices: returns current device catalog array', async () => {
  const res = await httpGet('/api/devices');
  assert.equal(res.status, 200);
  assert.equal(Array.isArray(res.data.devices), true);
  assert.equal(typeof res.data.count, 'number');
});

test('POST /api/telemetry/ingest: accepts valid sensor telemetry reading', async () => {
  const res = await httpPost('/api/telemetry/ingest', {
    deviceId: 'turbine-01',
    sensorType: 'temperature',
    value: 78.4,
    unit: 'C',
  });
  assert.equal(res.status, 202);
  assert.equal(res.data.status, 'accepted');
  assert.equal(res.data.reading.deviceId, 'turbine-01');
  assert.equal(res.data.reading.value, 78.4);
});

test('POST /api/telemetry/ingest: rejects payload missing deviceId or value', async () => {
  const res = await httpPost('/api/telemetry/ingest', {
    sensorType: 'temperature',
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, 'BAD_REQUEST');
});

test('POST /api/rules/validate: validates valid rule graph payload', async () => {
  const validRule = {
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'pump-01' } },
      { id: 'a1', type: 'actionNode', data: { category: 'action', actionType: 'sms' } },
    ],
    edges: [{ source: 's1', target: 'a1' }],
  };

  const res = await httpPost('/api/rules/validate', validRule);
  assert.equal(res.status, 200);
  assert.equal(res.data.valid, true);
  assert.equal(res.data.metadata.nodeCount, 2);
});

test('POST /api/rules/validate: returns validation errors for disconnected nodes', async () => {
  const invalidRule = {
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source' } },
      { id: 'dangling', type: 'conditionNode', data: { category: 'condition' } },
      { id: 'a1', type: 'actionNode', data: { category: 'action' } },
    ],
    edges: [{ source: 's1', target: 'a1' }],
  };

  const res = await httpPost('/api/rules/validate', invalidRule);
  assert.equal(res.status, 200);
  assert.equal(res.data.valid, false);
  assert.equal(res.data.errorCode, 'DANGLING_NODE');
});

test('POST /api/rules/compile: compiles AST execution plan or returns 400 on error', async () => {
  const validRule = {
    id: 'rule_pressure_check',
    name: 'Boiler Pressure Check',
    nodes: [
      { id: 'src_boiler', type: 'sourceNode', data: { category: 'source', deviceId: 'boiler-9' } },
      { id: 'act_alert', type: 'actionNode', data: { category: 'action', actionType: 'webhook' } },
    ],
    edges: [{ source: 'src_boiler', target: 'act_alert' }],
  };

  const successRes = await httpPost('/api/rules/compile', validRule);
  assert.equal(successRes.status, 200);
  assert.equal(successRes.data.status, 'success');
  assert.equal(successRes.data.ast.ruleId, 'rule_pressure_check');
  assert.deepEqual(successRes.data.ast.executionPlan, ['src_boiler', 'act_alert']);

  const failRes = await httpPost('/api/rules/compile', { nodes: [] });
  assert.equal(failRes.status, 400);
  assert.equal(failRes.data.error, 'EMPTY_GRAPH');
});

test('GET /unknown-route: returns standardized 404 NOT_FOUND response', async () => {
  const res = await httpGet('/api/non-existent-endpoint');
  assert.equal(res.status, 404);
  assert.equal(res.data.error, 'NOT_FOUND');
});
