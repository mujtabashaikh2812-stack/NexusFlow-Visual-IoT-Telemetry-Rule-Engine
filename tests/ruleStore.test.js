'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { RuleStore, RuleStoreError } = require('../src/core/ruleStore');
const { defaultRuleParser } = require('../src/core/ruleParser');

const testDir = path.resolve(__dirname, `../data/test-rules-${Date.now()}`);

test.after(() => {
  try {
    if (fs.existsSync(testDir)) {
      const files = fs.readdirSync(testDir);
      for (const file of files) {
        fs.unlinkSync(path.join(testDir, file));
      }
      fs.rmdirSync(testDir);
    }
  } catch (_) {}
});

function makeDummyAst(ruleId = 'rule_boiler_pressure') {
  return defaultRuleParser.parse({
    id: ruleId,
    name: 'Boiler Pressure Monitor',
    nodes: [
      { id: 's1', type: 'sourceNode', data: { category: 'source', deviceId: 'boiler-9' } },
      { id: 'c1', type: 'conditionNode', data: { category: 'condition', operator: '>', threshold: 120 } },
      { id: 'a1', type: 'actionNode', data: { category: 'action', actionType: 'sms' } },
    ],
    edges: [
      { id: 'e1', source: 's1', target: 'c1' },
      { id: 'e2', source: 'c1', target: 'a1' },
    ],
  });
}

test('RuleStore: initializes directory and persists rule with SHA-256 checksum', () => {
  const store = new RuleStore({ storageDir: testDir });
  const ast = makeDummyAst('rule_init_test');

  const meta = store.saveRule(ast);
  assert.equal(meta.ruleId, 'rule_init_test');
  assert.equal(typeof meta.checksum, 'string');
  assert.equal(meta.checksum.length, 64); // SHA-256 hex string length
  assert.ok(fs.existsSync(meta.filePath));

  const fetched = store.getRule('rule_init_test');
  assert.equal(fetched.ruleId, 'rule_init_test');
  assert.equal(fetched.ast.name, 'Boiler Pressure Monitor');
});

test('RuleStore: reads from disk when cache is flushed and verifies integrity', () => {
  const store = new RuleStore({ storageDir: testDir });
  const ast = makeDummyAst('rule_disk_read');
  store.saveRule(ast);

  // Clear in-memory cache to force reading from disk
  store.cache.clear();
  assert.equal(store.cache.size, 0);

  const fromDisk = store.getRule('rule_disk_read');
  assert.ok(fromDisk);
  assert.equal(fromDisk.ruleId, 'rule_disk_read');
  assert.equal(store.cache.size, 1); // Cached after disk hit
});

test('RuleStore: detects checksum mismatch if file is tampered', () => {
  const store = new RuleStore({ storageDir: testDir, verifyChecksum: true });
  const ast = makeDummyAst('rule_tamper_test');
  const meta = store.saveRule(ast);

  // Simulate file tampering by modifying the stored file
  const raw = JSON.parse(fs.readFileSync(meta.filePath, 'utf8'));
  raw.ast.name = 'TAMPERED NAME';
  fs.writeFileSync(meta.filePath, JSON.stringify(raw), 'utf8');

  // Evict cache to force disk read
  store.cache.clear();

  assert.throws(
    () => store.getRule('rule_tamper_test'),
    (err) => err instanceof RuleStoreError && err.code === 'CHECKSUM_MISMATCH'
  );
});

test('RuleStore: deletes rule from both cache and disk', () => {
  const store = new RuleStore({ storageDir: testDir });
  const ast = makeDummyAst('rule_delete_me');
  const meta = store.saveRule(ast);

  assert.equal(store.deleteRule('rule_delete_me'), true);
  assert.equal(store.getRule('rule_delete_me'), null);
  assert.equal(fs.existsSync(meta.filePath), false);

  // Deleting again returns false
  assert.equal(store.deleteRule('rule_delete_me'), false);
});

test('RuleStore: loads all valid rules on startup', () => {
  const store = new RuleStore({ storageDir: testDir });
  store.clear();

  store.saveRule(makeDummyAst('rule_bulk_1'));
  store.saveRule(makeDummyAst('rule_bulk_2'));
  store.saveRule(makeDummyAst('rule_bulk_3'));

  const restored = store.loadAllRules();
  assert.equal(restored.length, 3);
  assert.equal(store.cache.size, 3);
  assert.ok(store.cache.has('rule_bulk_1'));
  assert.ok(store.cache.has('rule_bulk_2'));
  assert.ok(store.cache.has('rule_bulk_3'));
});

test('RuleStore: exports snapshot bundle and imports back into clean store', () => {
  const storeA = new RuleStore({ storageDir: testDir });
  storeA.clear();

  storeA.saveRule(makeDummyAst('rule_export_1'));
  storeA.saveRule(makeDummyAst('rule_export_2'));

  const snapshot = storeA.exportSnapshot();
  assert.equal(snapshot.ruleCount, 2);
  assert.equal(snapshot.rules.length, 2);
  assert.equal(snapshot.schemaVersion, '1.0.0');

  const secondDir = path.resolve(__dirname, `../data/test-rules-import-${Date.now()}`);
  const storeB = new RuleStore({ storageDir: secondDir });

  const importResult = storeB.importSnapshot(snapshot);
  assert.equal(importResult.imported, 2);
  assert.equal(importResult.skipped, 0);
  assert.equal(storeB.getRule('rule_export_1').ruleId, 'rule_export_1');

  // Clean up storeB
  storeB.clear();
  try { fs.rmdirSync(secondDir); } catch (_) {}
});

test('RuleStore: sanitizes special characters in rule IDs for safe filenames', () => {
  const store = new RuleStore({ storageDir: testDir });
  const weirdId = 'rule:turbine#44/pressure@zone';
  const ast = makeDummyAst(weirdId);

  const meta = store.saveRule(ast);
  assert.ok(fs.existsSync(meta.filePath));
  assert.equal(store.getRule(weirdId).ruleId, weirdId);
});

test('RuleStore: getStats compiles accurate file tallies and byte counts', () => {
  const store = new RuleStore({ storageDir: testDir });
  store.clear();
  store.saveRule(makeDummyAst('stat_rule_1'));
  store.saveRule(makeDummyAst('stat_rule_2'));

  const stats = store.getStats();
  assert.equal(stats.cachedRules, 2);
  assert.equal(stats.persistedFiles, 2);
  assert.ok(stats.diskSizeBytes > 0);
});
