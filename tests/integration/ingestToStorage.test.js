'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { app, defaultRateLimiter } = require('../../src/server');
const { defaultRuleEvaluator } = require('../../src/core/ruleEvaluator');
const { defaultRuleStore } = require('../../src/core/ruleStore');
const { defaultAuditLogger } = require('../../src/core/auditLogger');
const { WebhookDispatcher } = require('../../src/alerts/webhookDispatcher');
const { NotificationService } = require('../../src/alerts/notificationService');

/**
 * Cross-Pod Integration Checkpoint 1 (Santosh Ingestion & Kuldeep Storage/Audit Contract)
 * Validates seamless telemetry flow:
 *   HTTP Telemetry Ingest -> Token Bucket Rate Limiter -> AST Rule Evaluator
 *   -> RuleStore Persistence + AuditLogger Trace -> Alert Dispatch (Webhook / Multi-Channel)
 */

let server = null;
let baseUrl = '';
let webhookServer = null;
let webhookUrl = '';
const receivedWebhooks = [];

function httpRequest(method, urlStr, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = payload
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      : {};

    const req = http.request(urlStr, { method, headers }, (res) => {
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
    if (payload) req.write(payload);
    req.end();
  });
}

test.before(async () => {
  defaultRateLimiter.reset();
  defaultAuditLogger.clear();

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  await new Promise((resolve) => {
    webhookServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        receivedWebhooks.push({ headers: req.headers, body: JSON.parse(raw) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ acknowledged: true }));
      });
    });
    webhookServer.listen(0, '127.0.0.1', () => {
      webhookUrl = `http://127.0.0.1:${webhookServer.address().port}/hook`;
      resolve();
    });
  });
});

test.after(async () => {
  defaultRuleEvaluator.unregisterRule('int_ingest_storage_rule');
  defaultRuleStore.deleteRule('int_ingest_storage_rule');
  defaultRateLimiter.reset();
  defaultAuditLogger.clear();

  if (server) await new Promise((resolve) => server.close(resolve));
  if (webhookServer) await new Promise((resolve) => webhookServer.close(resolve));
});

test('Integration Checkpoint 1: end-to-end ingestion -> evaluation -> persistence -> audit & alert dispatch', async () => {
  // 1. Deploy rule into live engine + persistent RuleStore
  const ruleGraph = {
    id: 'int_ingest_storage_rule',
    name: 'Boiler Pressure & Overheat Audit Pipeline',
    nodes: [
      { id: 'src-boiler', type: 'sourceNode', data: { deviceId: 'boiler-int-01', sensorType: 'pressure' } },
      { id: 'tf-avg', type: 'transformNode', data: { operation: 'moving-average', windowSize: 3 } },
      { id: 'cond-high', type: 'conditionNode', data: { operator: '>', threshold: 100 } },
      { id: 'act-alert', type: 'actionNode', data: { actionType: 'webhook', target: webhookUrl, cooldownSeconds: 0, priority: 'critical' } },
    ],
    edges: [
      { id: 'e1', source: 'src-boiler', target: 'tf-avg' },
      { id: 'e2', source: 'tf-avg', target: 'cond-high' },
      { id: 'e3', source: 'cond-high', target: 'act-alert' },
    ],
  };

  const deployRes = await httpRequest('POST', `${baseUrl}/api/rules/deploy`, ruleGraph);
  assert.equal(deployRes.status, 201);
  assert.equal(deployRes.data.persisted, true);
  assert.ok(deployRes.data.checksum);

  // 2. Feed batch telemetry readings (smoothing moving average: 90, 100, 125 -> avg = 105 > 100)
  const batch = [90, 100, 125];
  let lastIngestRes = null;
  for (const val of batch) {
    lastIngestRes = await httpRequest('POST', `${baseUrl}/api/telemetry/ingest`, {
      deviceId: 'boiler-int-01',
      sensorType: 'pressure',
      value: val,
      unit: 'PSI',
    });
    assert.equal(lastIngestRes.status, 202);
    assert.ok(lastIngestRes.headers['x-ratelimit-remaining']);
  }

  // Final reading pushes 3-sample moving average to 105 -> threshold > 100 breached!
  assert.equal(lastIngestRes.data.evaluation.alertsTriggered, 1);
  const triggeredAlert = lastIngestRes.data.evaluation.alerts[0];
  assert.equal(triggeredAlert.value, 105);

  // 3. Verify AuditLogger captured all 3 executions + the triggered alert trace
  const auditRes = await httpRequest('GET', `${baseUrl}/api/audit/logs?deviceId=boiler-int-01&triggeredOnly=true`);
  assert.equal(auditRes.status, 200);
  assert.equal(auditRes.data.count, 1);
  assert.equal(auditRes.data.logs[0].triggeredRuleIds[0], 'int_ingest_storage_rule');

  const statsRes = await httpRequest('GET', `${baseUrl}/api/audit/stats`);
  assert.equal(statsRes.status, 200);
  assert.ok(statsRes.data.totalRecorded >= 3);
  assert.ok(statsRes.data.p95Ms >= 0);

  // 4. Verify RuleStore snapshot export & integrity recovery
  const exportRes = await httpRequest('GET', `${baseUrl}/api/rules/export`);
  assert.equal(exportRes.status, 200);
  const exportedRule = exportRes.data.rules.find((r) => r.ast.ruleId === 'int_ingest_storage_rule');
  assert.ok(exportedRule);
  assert.equal(exportedRule.checksum, deployRes.data.checksum);

  // 5. Verify downstream alert dispatch (Webhook + Failover NotificationService)
  const webhookDispatcher = new WebhookDispatcher({ maxRetries: 1 });
  const delivery = await webhookDispatcher.dispatch(webhookUrl, triggeredAlert);
  assert.equal(delivery.status, 'delivered');
  assert.equal(receivedWebhooks.length, 1);
  assert.equal(receivedWebhooks[0].body.ruleId, 'int_ingest_storage_rule');

  const notifier = new NotificationService();
  const slackReceipt = await notifier.notify({
    channel: 'slack',
    target: '#plant-ops',
    message: triggeredAlert.message,
    severity: 'critical',
    ruleId: triggeredAlert.ruleId,
    value: triggeredAlert.value,
  });
  assert.equal(slackReceipt.status, 'delivered');
});
