'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const {
  TokenBucket,
  BackpressureMonitor,
  TelemetryRateLimiter,
  defaultRateLimiter,
} = require('../src/middleware/rateLimiter');
const { app } = require('../src/server');

// ---------------------------------------------------------------------------
// Unit Tests: TokenBucket
// ---------------------------------------------------------------------------

test('TokenBucket: initializes with proper capacity and full tokens', () => {
  const bucket = new TokenBucket({ capacity: 50, refillRate: 5 });
  assert.equal(bucket.capacity, 50);
  assert.equal(bucket.refillRate, 5);
  assert.equal(bucket.tokens, 50);
});

test('TokenBucket: rejects invalid capacity or refill rate', () => {
  assert.throws(() => new TokenBucket({ capacity: 0 }), /Capacity must be greater than 0/);
  assert.throws(() => new TokenBucket({ refillRate: -1 }), /Refill rate must be greater than 0/);
});

test('TokenBucket: consumes tokens up to capacity and denies deficit requests', () => {
  const bucket = new TokenBucket({ capacity: 3, refillRate: 1 });

  const r1 = bucket.tryConsume(1);
  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 2);

  const r2 = bucket.tryConsume(2);
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 0);

  // Bucket is empty: consumption should be denied
  const r3 = bucket.tryConsume(1);
  assert.equal(r3.allowed, false);
  assert.equal(r3.remaining, 0);
  assert.ok(r3.resetMs > 0);
});

test('TokenBucket: refills tokens over time without exceeding capacity', async () => {
  const bucket = new TokenBucket({ capacity: 10, refillRate: 100, initialTokens: 0 });
  assert.equal(bucket.tokens, 0);

  // Wait 30ms -> at 100 tokens/sec, should refill ~3 tokens
  await new Promise((resolve) => setTimeout(resolve, 35));
  const currentTokens = bucket.refill();
  assert.ok(currentTokens >= 2, `Expected >= 2 tokens, got ${currentTokens}`);

  // Artificial time advance to test capacity ceiling
  bucket.lastRefillTime = Date.now() - 5000;
  bucket.refill();
  assert.equal(bucket.tokens, 10);
});

test('TokenBucket: reset restores full tokens', () => {
  const bucket = new TokenBucket({ capacity: 20, refillRate: 2 });
  bucket.tryConsume(20);
  assert.equal(bucket.tokens, 0);

  bucket.reset();
  assert.equal(bucket.tokens, 20);
});

// ---------------------------------------------------------------------------
// Unit Tests: BackpressureMonitor
// ---------------------------------------------------------------------------

test('BackpressureMonitor: reports NORMAL when healthy', () => {
  const monitor = new BackpressureMonitor({ maxConcurrent: 100, criticalConcurrent: 200 });
  const status = monitor.getStatus();
  assert.equal(status.status, 'NORMAL');
  assert.equal(status.isOverloaded, false);
  assert.equal(status.inFlight, 0);
  monitor.stopLagMonitor();
});

test('BackpressureMonitor: reports WARNING and CRITICAL under high in-flight load', () => {
  const monitor = new BackpressureMonitor({ maxConcurrent: 10, criticalConcurrent: 20 });
  try {
    monitor.activeInFlight = 12;
    let s = monitor.getStatus();
    assert.equal(s.status, 'WARNING');
    assert.equal(s.isOverloaded, false);

    monitor.activeInFlight = 25;
    s = monitor.getStatus();
    assert.equal(s.status, 'CRITICAL');
    assert.equal(s.isOverloaded, true);

    monitor.recordShed();
    assert.equal(monitor.totalShedRequests, 1);
  } finally {
    monitor.stopLagMonitor();
  }
});

// ---------------------------------------------------------------------------
// Unit Tests: TelemetryRateLimiter (Isolation & Device Eviction)
// ---------------------------------------------------------------------------

test('TelemetryRateLimiter: isolates device limits independently', () => {
  const limiter = new TelemetryRateLimiter({
    deviceCapacity: 2,
    deviceRefillRate: 1,
    globalCapacity: 100,
    globalRefillRate: 50,
  });

  const b1 = limiter.getDeviceBucket('device-alpha');
  const b2 = limiter.getDeviceBucket('device-beta');

  // Exhaust device-alpha
  assert.equal(b1.tryConsume(1).allowed, true);
  assert.equal(b1.tryConsume(1).allowed, true);
  assert.equal(b1.tryConsume(1).allowed, false);

  // device-beta remains fresh and unthrottled
  assert.equal(b2.tryConsume(1).allowed, true);
  assert.equal(b2.tryConsume(1).allowed, true);
});

test('TelemetryRateLimiter: evicts dormant device buckets upon TTL expiration', () => {
  const limiter = new TelemetryRateLimiter({
    deviceCapacity: 10,
    deviceRefillRate: 5,
    bucketTtlMs: 50, // 50ms TTL for testing
  });

  limiter.getDeviceBucket('stale-device-1');
  limiter.getDeviceBucket('stale-device-2');
  assert.equal(limiter.deviceBuckets.size, 2);

  // Artificial time lapse
  const entry = limiter.deviceBuckets.get('stale-device-1');
  entry.lastAccess = Date.now() - 100;

  const evicted = limiter.evictStaleBuckets();
  assert.equal(evicted, 1);
  assert.equal(limiter.deviceBuckets.has('stale-device-1'), false);
  assert.equal(limiter.deviceBuckets.has('stale-device-2'), true);
});

test('TelemetryRateLimiter: reset restores specific device or clears all state', () => {
  const limiter = new TelemetryRateLimiter({ deviceCapacity: 5, deviceRefillRate: 1 });
  const b = limiter.getDeviceBucket('device-reset-test');
  b.tryConsume(5);
  assert.equal(b.tokens, 0);

  limiter.reset('device-reset-test');
  assert.equal(b.tokens, 5);

  limiter.reset();
  assert.equal(limiter.deviceBuckets.size, 0);
});

// ---------------------------------------------------------------------------
// Integration Tests: Express Telemetry Ingestion HTTP Endpoints
// ---------------------------------------------------------------------------

let testServer = null;
const basePort = 49200 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${basePort}`;

test.before(async () => {
  defaultRateLimiter.reset();
  await new Promise((resolve) => {
    testServer = app.listen(basePort, () => resolve());
  });
});

test.after(async () => {
  if (testServer) {
    await new Promise((resolve) => testServer.close(resolve));
  }
  defaultRateLimiter.reset();
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
    const payload = JSON.stringify(body || {});
    const req = http.request(
      `${baseUrl}${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers });
          } catch (_) {
            resolve({ status: res.statusCode, data, headers: res.headers });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('POST /api/telemetry/ingest: attaches rate limit headers to accepted requests', async () => {
  const res = await httpPost('/api/telemetry/ingest', {
    deviceId: 'device-headers-test',
    sensorType: 'temperature',
    value: 23.5,
  });

  assert.equal(res.status, 202);
  assert.ok(res.headers['x-ratelimit-limit']);
  assert.ok(res.headers['x-ratelimit-remaining']);
  assert.ok(res.headers['x-ratelimit-reset']);
  assert.equal(res.data.status, 'accepted');
});

test('POST /api/telemetry/ingest: throttles device when burst capacity is exceeded', async () => {
  const deviceId = 'flood-device-101';
  const bucket = defaultRateLimiter.getDeviceBucket(deviceId);

  // Artificially deplete bucket and hold lastRefillTime in future to guard against network latency refill
  bucket.tokens = 0;
  bucket.lastRefillTime = Date.now() + 10000;

  const res = await httpPost('/api/telemetry/ingest', {
    deviceId,
    sensorType: 'pressure',
    value: 104.2,
  });

  assert.equal(res.status, 429);
  assert.equal(res.data.error, 'TOO_MANY_REQUESTS');
  assert.equal(res.data.code, 'DEVICE_RATE_LIMIT_EXCEEDED');
  assert.ok(res.headers['retry-after']);
  assert.equal(res.headers['x-ratelimit-remaining'], '0');

  // Verify other devices are NOT blocked
  const resOther = await httpPost('/api/telemetry/ingest', {
    deviceId: 'healthy-device-202',
    sensorType: 'temperature',
    value: 20.0,
  });
  assert.equal(resOther.status, 202);
});

test('GET /api/telemetry/rate-limit/stats: returns detailed throttle metrics', async () => {
  const res = await httpGet('/api/telemetry/rate-limit/stats');
  assert.equal(res.status, 200);
  assert.ok(typeof res.data.activeDeviceBuckets === 'number');
  assert.ok(typeof res.data.globalRemainingTokens === 'number');
  assert.ok(res.data.metrics.totalRequests > 0);
  assert.ok(Array.isArray(res.data.metrics.topThrottledDevices));
  assert.equal(res.data.backpressure.status, 'NORMAL');
});

test('POST /api/telemetry/rate-limit/reset: clears throttled state for target device', async () => {
  const deviceId = 'reset-device-999';
  const bucket = defaultRateLimiter.getDeviceBucket(deviceId);
  bucket.tokens = 0;
  bucket.lastRefillTime = Date.now() + 10000;

  // Verify device is throttled
  const resBefore = await httpPost('/api/telemetry/ingest', {
    deviceId,
    sensorType: 'pressure',
    value: 105.0,
  });
  assert.equal(resBefore.status, 429);

  // Admin resets the device
  const resetRes = await httpPost('/api/telemetry/rate-limit/reset', { deviceId });
  assert.equal(resetRes.status, 200);
  assert.equal(resetRes.data.status, 'success');

  // Device can now send telemetry again
  const resAfter = await httpPost('/api/telemetry/ingest', {
    deviceId,
    sensorType: 'pressure',
    value: 105.0,
  });
  assert.equal(resAfter.status, 202);
});

test('TelemetryRateLimiter: sheds load with 503 when backpressure is CRITICAL', async () => {
  const isolatedMonitor = new BackpressureMonitor({ criticalConcurrent: 5 });
  const isolatedLimiter = new TelemetryRateLimiter({
    backpressureMonitor: isolatedMonitor,
  });

  const miniApp = express();
  miniApp.use(express.json());
  miniApp.post('/test/ingest', isolatedLimiter.middleware(), (req, res) => {
    res.status(200).json({ ok: true });
  });

  const miniServer = await new Promise((resolve) => {
    const s = miniApp.listen(0, () => resolve(s));
  });
  const port = miniServer.address().port;

  function localPost(body) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body || {});
      const req = http.request(
        `http://127.0.0.1:${port}/test/ingest`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers });
            } catch (_) {
              resolve({ status: res.statusCode, data, headers: res.headers });
            }
          });
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  try {
    // Normal request passes
    const res1 = await localPost({ deviceId: 'dev-1' });
    assert.equal(res1.status, 200);

    // Overloaded monitor triggers 503
    isolatedMonitor.activeInFlight = 10;
    const res2 = await localPost({ deviceId: 'dev-1' });
    assert.equal(res2.status, 503);
    assert.equal(res2.data.error, 'SERVICE_UNAVAILABLE');
    assert.equal(res2.data.code, 'BACKPRESSURE_LOAD_SHEDDING');
    assert.equal(res2.headers['retry-after'], '2');
  } finally {
    isolatedMonitor.stopLagMonitor();
    await new Promise((resolve) => miniServer.close(resolve));
  }
});

test('GET /api/health: reports rateLimiter subsystem online', async () => {
  const res = await httpGet('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.data.subsystems.rateLimiter, 'online');
});
