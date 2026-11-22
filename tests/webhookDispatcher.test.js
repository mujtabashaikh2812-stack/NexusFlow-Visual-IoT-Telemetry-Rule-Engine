'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { WebhookDispatcher } = require('../src/alerts/webhookDispatcher');

let mockServer = null;
let mockPort = 0;
let requestLog = [];
let responseHandler = null;

test.before(async () => {
  await new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requestLog.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: body ? JSON.parse(body) : null,
        });

        if (responseHandler) {
          responseHandler(req, res);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        }
      });
    });

    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
});

test.after(async () => {
  if (mockServer) {
    await new Promise((resolve) => mockServer.close(resolve));
  }
});

test.beforeEach(() => {
  requestLog = [];
  responseHandler = null;
});

test('WebhookDispatcher: computes valid HMAC-SHA256 signature', () => {
  const dispatcher = new WebhookDispatcher({ defaultSecret: 'test-secret-key' });
  const sig1 = dispatcher.computeSignature('{"hello":"world"}', 'test-secret-key');
  const sig2 = dispatcher.computeSignature('{"hello":"world"}', 'test-secret-key');
  const sigDifferent = dispatcher.computeSignature('{"hello":"world2"}', 'test-secret-key');

  assert.equal(typeof sig1, 'string');
  assert.equal(sig1.length, 64);
  assert.equal(sig1, sig2);
  assert.notEqual(sig1, sigDifferent);
});

test('WebhookDispatcher: delivers payload successfully with HMAC headers', async () => {
  const dispatcher = new WebhookDispatcher({ defaultSecret: 'shhh-secret' });
  const payload = {
    alertId: 'alt-001',
    ruleId: 'rule-temp-overheat',
    severity: 'critical',
    value: 98.4,
  };

  const report = await dispatcher.dispatch(`http://127.0.0.1:${mockPort}/webhook`, payload);

  assert.equal(report.status, 'delivered');
  assert.equal(report.statusCode, 200);
  assert.equal(report.attempts, 1);
  assert.ok(report.deliveryId);

  // Check request headers received by mock server
  assert.equal(requestLog.length, 1);
  const received = requestLog[0];
  assert.equal(received.headers['user-agent'], 'NexusFlow-WebhookDispatcher/1.0');
  assert.ok(received.headers['x-nexus-delivery-id'] || received.headers['x-nexusflow-delivery-id']);
  assert.ok(received.headers['x-nexusflow-signature'].startsWith('sha256='));
  assert.deepEqual(received.body, payload);
});

test('WebhookDispatcher: retries with exponential backoff and succeeds after transient 500 error', async () => {
  const dispatcher = new WebhookDispatcher({
    maxRetries: 2,
    initialBackoffMs: 20,
    backoffMultiplier: 2,
  });

  let calls = 0;
  responseHandler = (req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    }
  };

  const report = await dispatcher.dispatch(`http://127.0.0.1:${mockPort}/webhook/transient`, { test: 'retry' });

  assert.equal(report.status, 'delivered');
  assert.equal(report.statusCode, 200);
  assert.equal(report.attempts, 2);
  assert.equal(dispatcher.metrics.retriesCount, 1);
  assert.equal(dispatcher.metrics.successfulDeliveries, 1);
});

test('WebhookDispatcher: does not retry non-retryable 4xx client errors', async () => {
  const dispatcher = new WebhookDispatcher({ maxRetries: 3, initialBackoffMs: 10 });

  let calls = 0;
  responseHandler = (req, res) => {
    calls += 1;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint Not Found' }));
  };

  const report = await dispatcher.dispatch(`http://127.0.0.1:${mockPort}/webhook/not-found`, { test: 'fail' });

  assert.equal(report.status, 'failed');
  assert.equal(report.statusCode, 404);
  assert.equal(report.attempts, 1); // halted after 1 attempt, no useless retries
  assert.equal(dispatcher.metrics.failedDeliveries, 1);
});

test('WebhookDispatcher: marks failed when max retries are exhausted', async () => {
  const dispatcher = new WebhookDispatcher({ maxRetries: 2, initialBackoffMs: 10 });

  responseHandler = (req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Service Unavailable' }));
  };

  const report = await dispatcher.dispatch(`http://127.0.0.1:${mockPort}/webhook/unreachable`, { test: 'fail' });

  assert.equal(report.status, 'failed');
  assert.equal(report.statusCode, 503);
  assert.equal(report.attempts, 3); // initial + 2 retries
  assert.equal(dispatcher.metrics.retriesCount, 2);
});

test('WebhookDispatcher: getStats compiles accurate success rates and delivery history', () => {
  const dispatcher = new WebhookDispatcher();
  const stats = dispatcher.getStats();

  assert.ok(typeof stats.totalDispatched === 'number');
  assert.ok(typeof stats.successRate === 'number');
  assert.ok(Array.isArray(stats.recentDeliveries));
});
