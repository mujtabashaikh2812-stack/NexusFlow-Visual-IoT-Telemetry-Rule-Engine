'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runCompressionAudit,
  resolveConfig,
  readingAt,
  measureRawSizes,
  compressionRatio,
  storageToPerReading,
  DEFAULTS,
  TARGETS
} = require('../src/benchmarks/compressionAudit');
const { makeReading } = require('../src/benchmarks/ingestionStressTest');
const { startRealMongo } = require('./helpers.realMongo');

const COMPRESSION_ENV = ['COMPRESSION_READINGS', 'COMPRESSION_DEVICES', 'COMPRESSION_TARGET'];

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
  for (const k of COMPRESSION_ENV) cleared[k] = undefined;
  return cleared;
}

// ---------------------------------------------------------------- config

test('defaults: 20,000 readings from 100 devices, measured on the real store', async () => {
  await withEnv(cleanEnv(), () => {
    const cfg = resolveConfig();
    assert.equal(cfg.readings, 20000);
    assert.equal(cfg.devices, 100);
    assert.equal(cfg.target, 'mongo-memory');
    assert.deepEqual(DEFAULTS, { readings: 20000, devices: 100, target: 'mongo-memory' });
    assert.deepEqual(TARGETS, ['mongo-memory', 'memory']);
  });
});

test('environment variables set the config and explicit options win over them', async () => {
  await withEnv({ ...cleanEnv(), COMPRESSION_READINGS: '500', COMPRESSION_DEVICES: '5', COMPRESSION_TARGET: 'memory' }, () => {
    const cfg = resolveConfig();
    assert.equal(cfg.readings, 500);
    assert.equal(cfg.devices, 5);
    assert.equal(cfg.target, 'memory');
    assert.equal(resolveConfig({ readings: 7, target: 'mongo-memory' }).readings, 7);
    assert.equal(resolveConfig({ readings: 7, target: 'mongo-memory' }).target, 'mongo-memory');
  });
});

test('bad config is refused with a clear error', async () => {
  await withEnv(cleanEnv(), () => {
    assert.throws(() => resolveConfig({ readings: 0 }), RangeError);
    assert.throws(() => resolveConfig({ devices: 1.5 }), RangeError);
    assert.throws(() => resolveConfig({ target: 'cloud' }), RangeError);
  });
  await withEnv({ ...cleanEnv(), COMPRESSION_READINGS: 'many' }, () => {
    assert.throws(() => resolveConfig(), RangeError);
  });
});

// ---------------------------------------------------------------- pure helpers

test('readingAt matches the stress-test generator, devices take turns each second', () => {
  assert.deepEqual(readingAt(0, 3), makeReading(0, 0));
  assert.deepEqual(readingAt(4, 3), makeReading(1, 1));
  assert.equal(readingAt(4, 3).metadata.deviceId, makeReading(1, 1).metadata.deviceId);
});

test('measureRawSizes averages JSON and BSON bytes per reading', () => {
  const docs = [readingAt(0, 10), readingAt(1, 10), readingAt(2, 10)];
  const sizes = measureRawSizes(docs);
  assert.equal(sizes.readings, 3);
  assert.ok(sizes.rawJsonBytesPerReading > 0);
  assert.ok(sizes.bsonBytesPerReading > 0);
  const expectedJson = docs.reduce((s, d) => s + Buffer.byteLength(JSON.stringify(d), 'utf8'), 0) / 3;
  assert.equal(sizes.rawJsonBytesPerReading, Math.round(expectedJson * 100) / 100);
  assert.throws(() => measureRawSizes([]), RangeError);
});

test('compressionRatio divides raw JSON by stored bytes and is null without a stored size', () => {
  assert.equal(compressionRatio(160, 2), 80);
  assert.equal(compressionRatio(100, 3), 33.33);
  assert.equal(compressionRatio(100, null), null);
  assert.equal(compressionRatio(100, 0), null);
});

test('storageToPerReading turns $collStats sizes into per-reading figures', () => {
  assert.deepEqual(storageToPerReading({ size: 1000, storageSize: 300 }, 100), {
    uncompressedBytesPerReading: 10,
    storedBytesPerReading: 3
  });
  assert.deepEqual(storageToPerReading({ size: 1000, storageSize: 300 }, 0), {
    uncompressedBytesPerReading: null,
    storedBytesPerReading: null
  });
});

// ---------------------------------------------------------------- end to end

test('memory target: all readings stored, sizes real, stored size honestly n/a', async () => {
  const report = await runCompressionAudit({ readings: 300, devices: 10, target: 'memory' });
  assert.equal(report.target, 'memory');
  assert.equal(report.readings, 300);
  assert.equal(report.storedReadings, 300);
  assert.equal(report.complete, true);
  assert.ok(report.rawJsonBytesPerReading > 0);
  assert.equal(report.storedBytesPerReading, null);
  assert.equal(report.compressionRatio, null);
});

test('real mongod: time-series storage shrinks readings below raw JSON size', async (t) => {
  const probe = await startRealMongo();
  if (probe.skip) {
    t.skip(probe.skip);
    return;
  }
  await probe.server.stop();
  const report = await runCompressionAudit({ readings: 2000, devices: 20, target: 'mongo-memory' });
  assert.equal(report.complete, true);
  assert.equal(report.storedReadings, 2000);
  assert.ok(report.storedBytesPerReading > 0);
  assert.ok(report.storedBytesPerReading < report.rawJsonBytesPerReading, 'stored bytes should be below raw JSON');
  assert.ok(report.compressionRatio > 1);
  assert.ok(report.bucketCount >= 1, "at least one time-series bucket is reported");
});
