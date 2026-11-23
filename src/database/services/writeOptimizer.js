'use strict';

/**
 * High-throughput write tuning for telemetry (Day 7).
 *
 * A write concern tells MongoDB how many members must confirm a write, and
 * whether it must be in the on-disk journal, before the driver reports success.
 *
 *  - 'buffered' (default): { w: 1, j: false }. The primary acknowledges as soon
 *    as the write is applied in memory. Fastest for high-frequency sensor
 *    buffering. Trade-off: if the server crashes or loses power before the
 *    journal is flushed, the most recent acknowledged readings can be lost.
 *  - 'durable': { w: 'majority', j: true }. Waits for a majority of replica-set
 *    members and the journal. Slower; use it when no reading may be lost.
 *
 * The profile comes from the profile option or TELEMETRY_WRITE_PROFILE. An
 * explicit writeConcern option ({ w, j }) wins over the profile.
 *
 *  - resolveWriteConcern(options)                 pure: the validated { w, j }.
 *  - optimizeCollection(collection, options)      wraps a collection so every
 *                                                 bulkWrite carries the write concern
 *                                                 and stays unordered by default.
 *  - measureWriteEfficiency(collection, options)  writes N readings through a
 *                                                 BatchWriter and reports throughput,
 *                                                 bulk calls and what was stored.
 *
 * The in-memory fallback ignores the write concern (it has no journal), so the
 * same code runs there and against MongoDB. Loading this file starts nothing.
 */

const { performance } = require('node:perf_hooks');
const { BatchWriter } = require('./batchWriter');

const WRITE_PROFILES = Object.freeze({
  buffered: Object.freeze({ w: 1, j: false }),
  durable: Object.freeze({ w: 'majority', j: true })
});
const DEFAULT_PROFILE = 'buffered';

const DEFAULT_MEASURE = Object.freeze({
  writes: 10000,
  batchSize: 500,
  devices: 100
});

const quietLogger = { info() {}, warn() {}, error() {}, log() {} };

function positiveInt(label, value) {
  if (!Number.isFinite(value) || value < 1 || Math.floor(value) !== value) {
    throw new RangeError(`${label} must be a positive whole number (got ${value})`);
  }
  return value;
}

/** Checks a { w, j } pair and fills the defaults (w: 1, j: false). Throws on bad values. */
function validateWriteConcern(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError("writeConcern must be an object such as { w: 1, j: false }");
  }
  const w = input.w === undefined ? 1 : input.w;
  const j = input.j === undefined ? false : input.j;
  const wOk = w === 'majority' || (Number.isInteger(w) && w >= 1);
  if (!wOk) throw new RangeError(`writeConcern.w must be a whole number of at least 1 or 'majority' (got ${String(w)})`);
  if (typeof j !== 'boolean') throw new TypeError(`writeConcern.j must be true or false (got ${String(j)})`);
  return { w, j };
}

/**
 * Returns the write concern to use: explicit writeConcern, else the named
 * profile (options.profile, then TELEMETRY_WRITE_PROFILE, then 'buffered').
 * Pure apart from reading that one environment variable.
 */
function resolveWriteConcern(options = {}) {
  if (options.writeConcern !== undefined) return validateWriteConcern(options.writeConcern);
  const fromEnv = process.env.TELEMETRY_WRITE_PROFILE;
  const chosen =
    options.profile !== undefined
      ? options.profile
      : fromEnv !== undefined && fromEnv.trim() !== ''
        ? fromEnv
        : DEFAULT_PROFILE;
  const name = String(chosen).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(WRITE_PROFILES, name)) {
    throw new RangeError(`write profile must be one of: ${Object.keys(WRITE_PROFILES).join(', ')} (got ${String(chosen)})`);
  }
  return { ...WRITE_PROFILES[name] };
}

/**
 * Wraps a collection (anything with bulkWrite) so each bulk write uses the
 * resolved write concern. Operations are passed through unchanged; the caller's
 * bulk options win except for writeConcern, and ordered defaults to false.
 */
function optimizeCollection(collection, options = {}) {
  if (!collection || typeof collection.bulkWrite !== 'function') {
    throw new TypeError('optimizeCollection needs a collection with a bulkWrite method');
  }
  const writeConcern = resolveWriteConcern(options);
  return {
    collectionName: collection.collectionName,
    writeConcern: { ...writeConcern },
    bulkWrite(operations, bulkOptions = {}) {
      return collection.bulkWrite(operations, {
        ordered: false,
        ...bulkOptions,
        writeConcern: { ...writeConcern }
      });
    }
  };
}

/**
 * Writes `writes` synthetic readings through a BatchWriter into the collection,
 * using the resolved write concern, and reports what happened.
 *
 * Returns { writeConcern, readings, written, failed, dropped, complete,
 *           bulkCalls, averageBatch, seconds, writesPerSec }.
 * complete is true only when every reading was stored.
 */
async function measureWriteEfficiency(collection, options = {}) {
  const writes = positiveInt('writes', options.writes !== undefined ? options.writes : DEFAULT_MEASURE.writes);
  const batchSize = positiveInt('batchSize', options.batchSize !== undefined ? options.batchSize : DEFAULT_MEASURE.batchSize);
  const devices = positiveInt('devices', options.devices !== undefined ? options.devices : DEFAULT_MEASURE.devices);
  const clock = typeof options.clock === 'function' ? options.clock : () => performance.now();

  const optimized = optimizeCollection(collection, options);
  const bulkSizes = [];
  const counting = {
    collectionName: optimized.collectionName,
    bulkWrite(operations, bulkOptions) {
      bulkSizes.push(operations.length);
      return optimized.bulkWrite(operations, bulkOptions);
    }
  };

  const writer = new BatchWriter(counting, {
    batchSize,
    flushIntervalMs: 60000,
    logger: options.logger || quietLogger
  });

  const base = Date.UTC(2026, 10, 23, 0, 0, 0);
  const started = clock();
  try {
    for (let i = 0; i < writes; i++) {
      writer.add({
        timestamp: new Date(base + i),
        metadata: { deviceId: `device-${String((i % devices) + 1).padStart(3, '0')}`, sensorType: 'temperature' },
        value: 20 + (i % 10),
        unit: 'C'
      });
    }
    await writer.flush();
  } finally {
    await writer.close();
  }
  const elapsedMs = clock() - started;
  const stats = writer.getStats();
  const seconds = Math.max(elapsedMs, 0) / 1000;

  return {
    writeConcern: { ...optimized.writeConcern },
    readings: writes,
    written: stats.written,
    failed: stats.failed,
    dropped: stats.dropped,
    complete: stats.written === writes && stats.failed === 0 && stats.dropped === 0 && stats.unflushed === 0,
    bulkCalls: bulkSizes.length,
    averageBatch: bulkSizes.length ? Math.round(writes / bulkSizes.length) : 0,
    seconds: Math.round(seconds * 1000) / 1000,
    writesPerSec: seconds > 0 ? Math.round(stats.written / seconds) : stats.written
  };
}

module.exports = {
  WRITE_PROFILES,
  DEFAULT_PROFILE,
  validateWriteConcern,
  resolveWriteConcern,
  optimizeCollection,
  measureWriteEfficiency
};
