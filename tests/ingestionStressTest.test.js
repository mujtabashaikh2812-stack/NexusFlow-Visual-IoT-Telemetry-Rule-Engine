'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runIngestionStress,
  resolveConfig,
  makeReading,
  deviceIdFor,
  percentile,
  sliceDevices,
  DEFAULTS,
  LATENCY_GOAL_MS
} = require('../src/benchmarks/ingestionStressTest');
const { buildTelemetryDocument } = require('../src/database/models/TelemetryPoint');
const { startRealMongo } = require('./helpers.realMongo');

const quiet = { info() {}, warn() {}, error() {}, log() {} };
const STRESS_ENV = [
  'STRESS_DEVICES',
  'STRESS_WORKERS',
  'STRESS_READINGS_PER_DEVICE',
  'STRESS_TARGET',
  'STRESS_TARGET_RATE',
  'STRESS_VALIDATE',
  'STRESS_BATCH_SIZE'
];

/** Runs fn with the given environment variables set, then restores the originals. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function cleanEnv() {
  const cleared = {};
  for (const k of STRESS_ENV) cleared[k] = undefined;
  return cleared;
}

// ---------------------------------------------------------------- config

test('defaults match the sheet: 100 virtual devices and a 5,000 writes/sec goal', async () => {
  await withEnv(cleanEnv(), () => {
    const cfg = resolveConfig();
    assert.equal(cfg.devices, 100);
    assert.equal(DEFAULTS.devices, 100);
    assert.equal(cfg.targetRate, 5000);
    assert.equal(cfg.target, 'memory');
    assert.equal(cfg.validate, true);
    assert.equal(LATENCY_GOAL_MS, 10);
  });
});

test('environment variables set the configuration, explicit options win over them', async () => {
  await withEnv({ ...cleanEnv(), STRESS_DEVICES: '20', STRESS_WORKERS: '3', STRESS_READINGS_PER_DEVICE: '7', STRESS_VALIDATE: 'false' }, () => {
    const cfg = resolveConfig();
    assert.equal(cfg.devices, 20);
    assert.equal(cfg.workers, 3);
    assert.equal(cfg.readingsPerDevice, 7);
    assert.equal(cfg.validate, false);
    assert.equal(resolveConfig({ devices: 5 }).devices, 5);
  });
});

test('workers are never more than devices', async () => {
  await withEnv(cleanEnv(), () => {
    assert.equal(resolveConfig({ devices: 2, workers: 8 }).workers, 2);
  });
});

test('bad settings are refused with a clear message', async () => {
  await withEnv(cleanEnv(), () => {
    assert.throws(() => resolveConfig({ devices: 0 }), /devices must be a whole number of at least 1/);
    assert.throws(() => resolveConfig({ readingsPerDevice: 1.5 }), /readingsPerDevice/);
    assert.throws(() => resolveConfig({ target: 'cloud' }), /target must be one of memory, mongo-memory, env/);
  });
  await withEnv({ ...cleanEnv(), STRESS_WORKERS: 'many' }, () => {
    assert.throws(() => resolveConfig(), /STRESS_WORKERS/);
  });
});

// ---------------------------------------------------------------- pure helpers

test('device slices cover every device exactly once', () => {
  for (const [devices, workers] of [[100, 4], [10, 3], [7, 7], [5, 1]]) {
    const slices = sliceDevices(devices, workers);
    const seen = [];
    for (const s of slices) for (let i = s.firstDevice; i < s.firstDevice + s.deviceCount; i++) seen.push(i);
    assert.deepEqual(seen, Array.from({ length: devices }, (_, i) => i), `devices=${devices} workers=${workers}`);
  }
});

test('generated readings are deterministic, pass the schema and keep one sensor per device', () => {
  assert.equal(deviceIdFor(0), 'vdev-001');
  assert.equal(deviceIdFor(99), 'vdev-100');
  const a = makeReading(42, 9);
  const b = makeReading(42, 9);
  assert.deepEqual(a, b);
  assert.equal(makeReading(42, 10).metadata.sensorType, a.metadata.sensorType);
  for (let d = 0; d < 100; d += 13) {
    for (let s = 0; s < 20; s++) {
      const doc = buildTelemetryDocument(makeReading(d, s));
      assert.equal(doc.metadata.deviceId, deviceIdFor(d));
      assert.ok(Number.isFinite(doc.value));
    }
  }
});

test('percentile uses the nearest rank and handles an empty list', () => {
  assert.equal(percentile([], 99), null);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 100), 5);
  assert.equal(percentile([1, 2, 3, 4], 99), 4);
});

// ---------------------------------------------------------------- runs

test('in-memory run: 100 devices emit at once and every reading is stored with zero loss', async () => {
  const report = await withEnv(cleanEnv(), () =>
    runIngestionStress({ devices: 100, workers: 4, readingsPerDevice: 5, target: 'memory', logger: quiet })
  );
  assert.equal(report.produced, 500);
  assert.equal(report.accepted, 500);
  assert.equal(report.rejected, 0);
  assert.equal(report.stored, 500);
  assert.equal(report.lost, 0);
  assert.equal(report.dropped, 0);
  assert.equal(report.failed, 0);
  assert.equal(report.unflushed, 0);
  assert.equal(report.devicesComplete, 100);
  assert.equal(report.zeroLoss, true);
  assert.equal(report.passed, true);
  assert.equal(report.storeMode, 'memory');
  assert.ok(report.writesPerSec > 0);
  assert.ok(report.batches >= 1);
});

test('uneven slices and a batch size that does not divide the total still lose nothing', async () => {
  const report = await withEnv(cleanEnv(), () =>
    runIngestionStress({ devices: 11, workers: 3, readingsPerDevice: 13, batchSize: 7, target: 'memory', logger: quiet })
  );
  assert.equal(report.produced, 143);
  assert.equal(report.stored, 143);
  assert.equal(report.devicesComplete, 11);
  assert.equal(report.passed, true);
});

test('validation can be switched off for raw throughput without changing the result', async () => {
  const report = await withEnv(cleanEnv(), () =>
    runIngestionStress({ devices: 10, workers: 2, readingsPerDevice: 4, validate: false, target: 'memory', logger: quiet })
  );
  assert.equal(report.stored, 40);
  assert.equal(report.passed, true);
});

test('real mongod run: the time-series collection stores every reading with zero loss', async (t) => {
  const probe = await startRealMongo();
  if (probe.skip) return t.skip(probe.skip);
  await probe.server.stop();
  const report = await withEnv(cleanEnv(), () =>
    runIngestionStress({ devices: 20, workers: 4, readingsPerDevice: 10, target: 'mongo-memory', logger: quiet })
  );
  assert.equal(report.storeMode, 'mongodb');
  assert.equal(report.produced, 200);
  assert.equal(report.stored, 200);
  assert.equal(report.devicesComplete, 20);
  assert.equal(report.zeroLoss, true);
  assert.equal(report.passed, true);
});

test('env target with MongoDB unreachable falls back to memory and says so', async () => {
  const env = {
    ...cleanEnv(),
    MONGODB_URI: 'mongodb://127.0.0.1:27099/nexusflow',
    DB_MAX_RETRIES: '1',
    DB_BASE_DELAY_MS: '50',
    DB_MAX_DELAY_MS: '100'
  };
  const report = await withEnv(env, () =>
    runIngestionStress({ devices: 5, workers: 2, readingsPerDevice: 3, target: 'env', logger: quiet })
  );
  assert.equal(report.storeMode, 'memory');
  assert.equal(report.stored, 15);
  assert.equal(report.passed, true);
  assert.equal(JSON.stringify(report).includes('27099'), false, 'report must not echo the connection address');
});
