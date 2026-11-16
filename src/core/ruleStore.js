'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * NexusFlow Rule State Persistence & Schema Serialization Store
 * Provides durable file-backed persistence and high-speed in-memory caching
 * for compiled AST rule pipelines with SHA-256 integrity checksums.
 */

class RuleStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuleStoreError';
    this.code = code;
    this.details = details;
  }
}

class RuleStore {
  /**
   * @param {Object} options
   * @param {string} [options.storageDir] - Directory where rule JSON files are saved
   * @param {boolean} [options.verifyChecksum] - Whether to enforce SHA-256 integrity on read (default true)
   */
  constructor(options = {}) {
    this.storageDir = options.storageDir || path.resolve(__dirname, '../../data/rules');
    this.verifyChecksum = options.verifyChecksum !== false;
    this.cache = new Map(); // ruleId -> ruleData

    this._ensureDirectory();
  }

  _ensureDirectory() {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
    } catch (err) {
      throw new RuleStoreError('DIR_INIT_FAILED', `Failed to initialize storage directory: ${err.message}`, { path: this.storageDir });
    }
  }

  _getFilePath(ruleId) {
    // Sanitize ruleId for file system safety
    const safeId = String(ruleId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.storageDir, `${safeId}.json`);
  }

  _computeChecksum(data) {
    return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }

  /**
   * Persists an AST rule to disk and updates in-memory cache.
   * Uses atomic write (write to temp file then rename) to prevent file corruption.
   * @param {Object} ast - Compiled rule AST
   * @returns {Object} Stored record metadata
   */
  saveRule(ast) {
    if (!ast || !ast.ruleId) {
      throw new RuleStoreError('INVALID_RULE', 'Rule AST must contain a valid ruleId');
    }

    const ruleId = String(ast.ruleId);
    const now = new Date().toISOString();

    const record = {
      ruleId,
      name: ast.name || 'Untitled Rule',
      version: ast.version || '1.0.0',
      savedAt: now,
      ast,
      checksum: this._computeChecksum(ast),
    };

    const targetPath = this._getFilePath(ruleId);
    const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;

    try {
      this._ensureDirectory();
      const serialized = JSON.stringify(record, null, 2);
      fs.writeFileSync(tempPath, serialized, 'utf8');
      fs.renameSync(tempPath, targetPath);

      // Update in-memory cache
      this.cache.set(ruleId, record);

      return {
        ruleId,
        savedAt: now,
        checksum: record.checksum,
        filePath: targetPath,
      };
    } catch (err) {
      // Clean up orphaned temp file if write/rename failed
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (_) {}

      throw new RuleStoreError('SAVE_FAILED', `Failed to persist rule "${ruleId}": ${err.message}`, { ruleId });
    }
  }

  /**
   * Retrieves a rule by ID, checking cache first, then disk with checksum verification.
   * @param {string} ruleId
   * @returns {Object|null} The stored rule record or null if not found
   */
  getRule(ruleId) {
    if (!ruleId) return null;
    const id = String(ruleId);

    // 1. Cache hit
    if (this.cache.has(id)) {
      return this.cache.get(id);
    }

    // 2. Disk lookup
    const targetPath = this._getFilePath(id);
    if (!fs.existsSync(targetPath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(targetPath, 'utf8');
      const record = JSON.parse(raw);

      if (this.verifyChecksum && record.checksum) {
        const expected = this._computeChecksum(record.ast);
        if (expected !== record.checksum) {
          throw new RuleStoreError('CHECKSUM_MISMATCH', `Data corruption detected in rule file for "${id}"`, { ruleId: id });
        }
      }

      this.cache.set(id, record);
      return record;
    } catch (err) {
      if (err instanceof RuleStoreError) throw err;
      throw new RuleStoreError('READ_FAILED', `Failed to read rule file "${id}": ${err.message}`, { ruleId: id });
    }
  }

  /**
   * Deletes a rule from both cache and disk.
   * @param {string} ruleId
   * @returns {boolean} True if the rule existed and was deleted
   */
  deleteRule(ruleId) {
    if (!ruleId) return false;
    const id = String(ruleId);

    const hadCached = this.cache.delete(id);
    const targetPath = this._getFilePath(id);

    let hadFile = false;
    if (fs.existsSync(targetPath)) {
      try {
        fs.unlinkSync(targetPath);
        hadFile = true;
      } catch (err) {
        throw new RuleStoreError('DELETE_FAILED', `Failed to delete rule file "${id}": ${err.message}`, { ruleId: id });
      }
    }

    return hadCached || hadFile;
  }

  /**
   * Scans storage directory, validates integrity, and reloads all rules into cache.
   * @returns {Array<Object>} List of all valid restored rule records
   */
  loadAllRules() {
    this._ensureDirectory();
    this.cache.clear();

    const restored = [];
    const files = fs.readdirSync(this.storageDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const fullPath = path.join(this.storageDir, file);
      try {
        const raw = fs.readFileSync(fullPath, 'utf8');
        const record = JSON.parse(raw);

        if (!record || !record.ruleId || !record.ast) {
          console.warn(`[RuleStore] Skipping malformed rule file: ${file}`);
          continue;
        }

        if (this.verifyChecksum && record.checksum) {
          const expected = this._computeChecksum(record.ast);
          if (expected !== record.checksum) {
            console.warn(`[RuleStore] Integrity warning: Checksum mismatch for ${file}. Skipping.`);
            continue;
          }
        }

        this.cache.set(record.ruleId, record);
        restored.push(record);
      } catch (err) {
        console.warn(`[RuleStore] Error reading rule file ${file}: ${err.message}`);
      }
    }

    return restored;
  }

  /**
   * Exports a snapshot bundle of all active rules for backup and migration.
   * @returns {Object} Schema-compliant export bundle
   */
  exportSnapshot() {
    const rules = Array.from(this.cache.values());
    return {
      schemaVersion: '1.0.0',
      exportedAt: new Date().toISOString(),
      ruleCount: rules.length,
      rules,
    };
  }

  /**
   * Imports a snapshot bundle, persisting each rule.
   * @param {Object} bundle - The snapshot bundle exported via exportSnapshot()
   * @param {Object} [options]
   * @param {boolean} [options.overwrite=true]
   * @returns {Object} Import results tally
   */
  importSnapshot(bundle, options = {}) {
    if (!bundle || !Array.isArray(bundle.rules)) {
      throw new RuleStoreError('INVALID_SNAPSHOT', 'Snapshot must contain a "rules" array');
    }

    const overwrite = options.overwrite !== false;
    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const item of bundle.rules) {
      const ast = item.ast || item;
      if (!ast || !ast.ruleId) {
        skipped++;
        continue;
      }

      if (!overwrite && this.cache.has(ast.ruleId)) {
        skipped++;
        continue;
      }

      try {
        this.saveRule(ast);
        imported++;
      } catch (err) {
        errors.push({ ruleId: ast.ruleId, error: err.message });
      }
    }

    return {
      totalInBundle: bundle.rules.length,
      imported,
      skipped,
      errors,
    };
  }

  /**
   * Clears all stored rules from disk and cache.
   */
  clear() {
    this.cache.clear();
    if (fs.existsSync(this.storageDir)) {
      const files = fs.readdirSync(this.storageDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            fs.unlinkSync(path.join(this.storageDir, file));
          } catch (_) {}
        }
      }
    }
  }

  /**
   * Returns storage diagnostics and tallies.
   */
  getStats() {
    let diskSizeBytes = 0;
    let fileCount = 0;

    if (fs.existsSync(this.storageDir)) {
      const files = fs.readdirSync(this.storageDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const stat = fs.statSync(path.join(this.storageDir, file));
            diskSizeBytes += stat.size;
            fileCount++;
          } catch (_) {}
        }
      }
    }

    return {
      storageDir: this.storageDir,
      cachedRules: this.cache.size,
      persistedFiles: fileCount,
      diskSizeBytes,
    };
  }
}

const defaultRuleStore = new RuleStore();

module.exports = {
  RuleStore,
  RuleStoreError,
  defaultRuleStore,
};
