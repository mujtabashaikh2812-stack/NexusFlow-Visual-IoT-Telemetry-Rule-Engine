'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runAudit, buildScorecard, resolveAuditConfig, DEFAULTS } = require('../src/benchmarks/ingestionAudit');
const { startRealMongo } = require('./helpers.realMongo');

const quiet = { info() {}, warn() {}, error() {}, log() {} };
const AUDIT_ENV = ['AUDIT_RUNS', 'AUDIT_TARGET', 'AUDIT_OUT', 'AUDIT_DEVICES', 'AUDIT_READINGS_PER_DEVICE'];

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of AUDIT_ENV) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of AUDIT_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const config = {
  devices: 100,
  workers: 4,
  readingsPerDevice: 300,
  runs: 2,
  target: 'mongo-memory',
  throughputGoal: 5000,
  batchSize: 500,
  latencyGoalMs: 10,
  outFile: '/unused.json'
};

/** A run record that meets every goal, as summariseRun would keep it. */
function goodRun(i, overrides = {}) {
  return {
    run: i,
    storeMode: 'mongodb',
    serverVersion: '8.2.6',
    produced: 30000,
    stored: 30000,
    lost: 0,
    dropped: 0,
    failed: 0,
    unflushed: 0,
    devicesComplete: 100,
    corruptedReadings: 0,
    missingReadings: 0,
    elapsedMs: 2000,
    writesPerSec: 15000,
    batches: 60,
    batchLatencyMs: { p50: 5, p95: 9, p99: 9.5, max: 9.9 },
    zeroLoss: true,
    passed: true,
    ...overrides
  };
}

test('scorecard passes when every run meets every goal', () => {
  const card = buildScorecard([goodRun(1), goodRun(2)], config, {}, '2026-01-01T00:00:00.000Z');
  assert.equal(card.verdict, 'PASS');
  assert.deepEqual(
    card.criteria.map((c) => [c.name, c.passed]),
    [
      ['throughput', true],
      ['zeroLoss', true],
      ['zeroCorruption', true],
      ['writeLatency', true]
    ]
  );
  assert.equal(card.config.readingsPerRun, 30000);
});

test('scorecard fails when one run is below 5,000 writes per second', () => {
  const card = buildScorecard([goodRun(1), goodRun(2, { writesPerSec: 4999.9 })], config);
  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.criteria.find((c) => c.name === 'throughput').passed, false);
  assert.equal(card.criteria.find((c) => c.name === 'throughput').measured, 4999.9);
});

test('scorecard fails when the p99 write latency is above 10 ms in any run', () => {
  const card = buildScorecard([goodRun(1, { batchLatencyMs: { p50: 5, p95: 9, p99: 10.5, max: 11 } }), goodRun(2)], config);
  assert.equal(card.verdict, 'FAIL');
  const latency = card.criteria.find((c) => c.name === 'writeLatency');
  assert.equal(latency.passed, false);
  assert.equal(latency.measured, 10.5);
});

test('scorecard fails on any loss, and on any corrupted or missing reading', () => {
  const lost = buildScorecard([goodRun(1, { stored: 29999, lost: 1, zeroLoss: false })], config);
  assert.equal(lost.verdict, 'FAIL');
  assert.equal(lost.criteria.find((c) => c.name === 'zeroLoss').passed, false);

  const corrupt = buildScorecard([goodRun(1, { corruptedReadings: 2 })], config);
  assert.equal(corrupt.verdict, 'FAIL');
  assert.equal(corrupt.criteria.find((c) => c.name === 'zeroCorruption').measured, 2);

  const missing = buildScorecard([goodRun(1, { missingReadings: 1 })], config);
  assert.equal(missing.criteria.find((c) => c.name === 'zeroCorruption').passed, false);
});

test('scorecard fails when a latency was not measured at all', () => {
  const card = buildScorecard([goodRun(1, { batchLatencyMs: { p50: null, p95: null, p99: null, max: null } })], config);
  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.criteria.find((c) => c.name === 'writeLatency').measured, null);
});

test('scorecard says plainly when a run did not write to MongoDB', () => {
  const card = buildScorecard([goodRun(1, { storeMode: 'memory', serverVersion: null })], { ...config, target: 'memory' });
  assert.ok(card.caveats.some((c) => c.includes('did not write to MongoDB')));
  assert.ok(card.caveats.some((c) => c.includes('not MongoDB')));
});

test('scorecard notes when the first bulk write is the slowest in every run', () => {
  const slowFirst = { p50: 5, p95: 9, p99: 1000, max: 1000, first: 1000 };
  const card = buildScorecard([goodRun(1, { batchLatencyMs: slowFirst }), goodRun(2, { batchLatencyMs: slowFirst })], config);
  assert.equal(card.verdict, 'FAIL');
  assert.ok(card.caveats.some((c) => c.includes('first one to finish')));
  const normal = buildScorecard([goodRun(1), goodRun(2)], config);
  assert.equal(normal.caveats.some((c) => c.includes('first one to finish')), false);
});

test('scorecard refuses to build from no runs', () => {
  assert.throws(() => buildScorecard([], config), RangeError);
});

test('audit settings: defaults are 3 runs against a throwaway mongod, goal 5,000 writes/sec and 10 ms', async () => {
  const cfg = await withEnv({}, () => resolveAuditConfig({ outFile: '/unused.json' }));
  assert.equal(cfg.runs, 3);
  assert.equal(cfg.target, 'mongo-memory');
  assert.equal(cfg.throughputGoal, 5000);
  assert.equal(cfg.latencyGoalMs, 10);
  assert.equal(DEFAULTS.runs, 3);
});

test('audit settings: environment sets the run count and target, and bad values are refused', async () => {
  const cfg = await withEnv({ AUDIT_RUNS: '5', AUDIT_TARGET: 'memory' }, () => resolveAuditConfig({ outFile: '/unused.json' }));
  assert.equal(cfg.runs, 5);
  assert.equal(cfg.target, 'memory');
  await withEnv({}, () => {
    assert.throws(() => resolveAuditConfig({ target: 'cloud-cluster' }), RangeError);
    assert.throws(() => resolveAuditConfig({ runs: 0 }), RangeError);
    assert.throws(() => resolveAuditConfig({ runs: 2.5 }), RangeError);
  });
});

test('memory audit writes a scorecard file that reads back with the same verdict and no connection string', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-audit-'));
  const outFile = path.join(dir, 'scorecard.json');
  try {
    const card = await withEnv({}, () =>
      runAudit({ target: 'memory', runs: 2, devices: 10, workers: 2, readingsPerDevice: 5, outFile, logger: quiet })
    );
    const text = fs.readFileSync(outFile, 'utf8');
    const back = JSON.parse(text);
    assert.equal(back.verdict, card.verdict);
    assert.equal(back.runs.length, 2);
    assert.equal(back.config.readingsPerRun, 50);
    assert.ok(back.runs.every((r) => r.corruptedReadings === 0 && r.missingReadings === 0 && r.zeroLoss === true));
    assert.equal(/mongodb(\+srv)?:\/\//i.test(text), false, 'scorecard must not contain a connection string');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real mongod audit: every reading stored, none corrupted, scorecard written', async (t) => {
  const probe = await startRealMongo();
  if (probe.skip) return t.skip(probe.skip);
  await probe.server.stop();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-audit-mongo-'));
  const outFile = path.join(dir, 'scorecard.json');
  try {
    const card = await withEnv({}, () =>
      runAudit({ target: 'mongo-memory', runs: 1, devices: 20, workers: 4, readingsPerDevice: 10, outFile, logger: quiet })
    );
    assert.equal(card.runs[0].storeMode, 'mongodb');
    assert.equal(card.runs[0].stored, 200);
    assert.equal(card.runs[0].corruptedReadings, 0);
    assert.equal(card.criteria.find((c) => c.name === 'zeroLoss').passed, true);
    assert.equal(JSON.parse(fs.readFileSync(outFile, 'utf8')).verdict, card.verdict);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
