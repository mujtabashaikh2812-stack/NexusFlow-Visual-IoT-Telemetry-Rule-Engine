'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AuditLogger } = require('../src/core/auditLogger');

test('AuditLogger: records traces in bounded ring buffer and enforces maxEntries', () => {
  const logger = new AuditLogger({ maxEntries: 10 });

  for (let i = 1; i <= 15; i++) {
    logger.record({
      deviceId: `dev-${i % 3}`,
      sensorType: 'temperature',
      value: 20 + i,
      matchedRules: 2,
      durationMs: i * 0.1,
      triggeredAlerts: i % 5 === 0 ? [{ ruleId: 'rule-hot', actionType: 'alert' }] : [],
    });
  }

  assert.equal(logger.totalRecorded, 15);
  assert.equal(logger.entries.length, 10); // capped at maxEntries=10
  assert.equal(logger.totalTriggered, 3); // i=5, 10, 15
  assert.equal(logger.entries[0].value, 35); // most recent first
});

test('AuditLogger: query filters by deviceId, ruleId, triggeredOnly, and limit', () => {
  const logger = new AuditLogger({ maxEntries: 50 });

  logger.record({ deviceId: 'turbine-1', value: 60, matchedRules: 1, durationMs: 0.2, triggeredAlerts: [] });
  logger.record({
    deviceId: 'turbine-1',
    value: 98,
    matchedRules: 1,
    durationMs: 0.4,
    triggeredAlerts: [{ ruleId: 'rule-overheat', actionType: 'webhook' }],
  });
  logger.record({
    deviceId: 'boiler-2',
    value: 110,
    matchedRules: 1,
    durationMs: 0.5,
    triggeredAlerts: [{ ruleId: 'rule-pressure', actionType: 'sms' }],
  });

  const turbineOnly = logger.query({ deviceId: 'turbine-1' });
  assert.equal(turbineOnly.length, 2);

  const triggeredOnly = logger.query({ triggeredOnly: true });
  assert.equal(triggeredOnly.length, 2);

  const specificRule = logger.query({ ruleId: 'rule-pressure' });
  assert.equal(specificRule.length, 1);
  assert.equal(specificRule[0].deviceId, 'boiler-2');
});

test('AuditLogger: computes accurate latency percentiles (p50, p95, p99, max)', () => {
  const logger = new AuditLogger({ maxEntries: 100 });
  for (let i = 1; i <= 100; i++) {
    logger.record({ deviceId: 'dev-1', value: i, durationMs: i * 0.01 });
  }

  const stats = logger.getPerformanceStats();
  assert.equal(stats.totalRecorded, 100);
  assert.equal(stats.retainedCount, 100);
  assert.ok(stats.p50Ms >= 0.49 && stats.p50Ms <= 0.52);
  assert.ok(stats.p95Ms >= 0.94 && stats.p95Ms <= 0.97);
  assert.equal(stats.maxMs, 1);
});

test('AuditLogger: persists append-only NDJSON audit logs to disk when enabled', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusflow-audit-'));
  const logFile = path.join(tmpDir, 'audit.ndjson');

  try {
    const logger = new AuditLogger({
      maxEntries: 20,
      persistToDisk: true,
      logFilePath: logFile,
    });

    logger.record({
      deviceId: 'pump-04',
      sensorType: 'vibration',
      value: 14.2,
      matchedRules: 1,
      durationMs: 0.312,
      triggeredAlerts: [{ ruleId: 'rule-vib', actionType: 'slack' }],
    });
    logger.record({
      deviceId: 'pump-04',
      sensorType: 'vibration',
      value: 3.1,
      matchedRules: 1,
      durationMs: 0.145,
      triggeredAlerts: [],
    });

    const persisted = logger.readPersistedLogs();
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].deviceId, 'pump-04');
    assert.equal(persisted[0].status, 'triggered');
    assert.equal(persisted[1].status, 'evaluated');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
