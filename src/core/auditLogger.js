'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * NexusFlow Execution Audit Logger & Performance Tracer
 * Records high-resolution rule execution traces (evaluation latency, condition outcomes,
 * triggered actions) in a bounded in-memory ring buffer with optional NDJSON disk logging
 * for compliance, debugging, and SLA performance percentiles.
 */

class AuditLogger {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxEntries=1000] - Maximum in-memory trace entries retained
   * @param {string} [options.logFilePath] - Optional NDJSON append-only disk log path
   * @param {boolean} [options.persistToDisk=false] - Enable append-only file persistence
   */
  constructor(options = {}) {
    this.maxEntries = Math.max(10, options.maxEntries || 1000);
    this.persistToDisk = Boolean(options.persistToDisk && options.logFilePath);
    this.logFilePath = options.logFilePath ? path.resolve(options.logFilePath) : null;

    /** @type {Array<Object>} */
    this.entries = [];
    this.totalRecorded = 0;
    this.totalTriggered = 0;
    this.totalLatencyMs = 0;

    if (this.persistToDisk && this.logFilePath) {
      fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
    }
  }

  /**
   * Records a single rule evaluation or telemetry ingestion trace.
   * @param {Object} traceData
   * @returns {Object} Stored immutable audit record
   */
  record(traceData = {}) {
    const durationMs = typeof traceData.durationMs === 'number'
      ? Math.round(traceData.durationMs * 10000) / 10000
      : 0;
    const triggeredAlerts = Array.isArray(traceData.triggeredAlerts) ? traceData.triggeredAlerts : [];
    const triggeredCount = triggeredAlerts.length;

    const entry = {
      traceId: traceData.traceId || (crypto.randomUUID ? crypto.randomUUID() : `tr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      timestamp: traceData.timestamp || new Date().toISOString(),
      deviceId: traceData.deviceId || 'unknown',
      sensorType: traceData.sensorType || 'generic',
      value: traceData.value,
      matchedRules: typeof traceData.matchedRules === 'number' ? traceData.matchedRules : 0,
      triggeredCount,
      triggeredRuleIds: triggeredAlerts.map((a) => a.ruleId),
      actionTypes: triggeredAlerts.map((a) => a.actionType || 'alert'),
      durationMs,
      durationMicroseconds: Math.round(durationMs * 1000 * 10) / 10,
      nodeTraces: Array.isArray(traceData.nodeTraces) ? traceData.nodeTraces : [],
      status: traceData.error ? 'error' : (triggeredCount > 0 ? 'triggered' : 'evaluated'),
      error: traceData.error || null,
    };

    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.pop();
    }

    this.totalRecorded += 1;
    this.totalTriggered += triggeredCount;
    this.totalLatencyMs += durationMs;

    if (this.persistToDisk && this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch (err) {
        console.error(`[AuditLogger] Failed to append audit log:`, err.message);
      }
    }

    return entry;
  }

  /**
   * Queries stored audit entries using optional filters.
   * @param {Object} [filters]
   * @param {string} [filters.deviceId]
   * @param {string} [filters.ruleId]
   * @param {boolean} [filters.triggeredOnly]
   * @param {string} [filters.since] - ISO timestamp lower bound
   * @param {number} [filters.limit=50]
   * @returns {Array<Object>}
   */
  query(filters = {}) {
    const limit = Math.min(this.maxEntries, Math.max(1, Number(filters.limit) || 50));
    const sinceMs = filters.since ? new Date(filters.since).getTime() : null;

    const results = [];
    for (const entry of this.entries) {
      if (filters.deviceId && entry.deviceId !== filters.deviceId) continue;
      if (filters.ruleId && !entry.triggeredRuleIds.includes(filters.ruleId)) continue;
      if (filters.triggeredOnly && entry.triggeredCount === 0) continue;
      if (sinceMs && new Date(entry.timestamp).getTime() < sinceMs) continue;

      results.push(entry);
      if (results.length >= limit) break;
    }

    return results;
  }

  /**
   * Computes high-resolution execution latency percentiles and compliance counters.
   * @returns {Object}
   */
  getPerformanceStats() {
    const count = this.entries.length;
    if (count === 0) {
      return {
        totalRecorded: this.totalRecorded,
        retainedCount: 0,
        totalTriggered: this.totalTriggered,
        avgLatencyMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
      };
    }

    const sorted = this.entries.map((e) => e.durationMs).sort((a, b) => a - b);
    const percentile = (p) => sorted[Math.min(count - 1, Math.floor(count * p))];

    return {
      totalRecorded: this.totalRecorded,
      retainedCount: count,
      totalTriggered: this.totalTriggered,
      avgLatencyMs: Math.round((this.totalLatencyMs / this.totalRecorded) * 10000) / 10000,
      p50Ms: percentile(0.50),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: sorted[count - 1],
    };
  }

  /**
   * Reads persisted NDJSON entries from disk when disk logging is enabled.
   * @returns {Array<Object>}
   */
  readPersistedLogs() {
    if (!this.logFilePath || !fs.existsSync(this.logFilePath)) {
      return [];
    }
    const content = fs.readFileSync(this.logFilePath, 'utf8').trim();
    if (!content) return [];
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  clear() {
    this.entries = [];
    this.totalRecorded = 0;
    this.totalTriggered = 0;
    this.totalLatencyMs = 0;
  }
}

const defaultAuditLogger = new AuditLogger({ maxEntries: 1000 });

module.exports = {
  AuditLogger,
  defaultAuditLogger,
};
