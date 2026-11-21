'use strict';

/**
 * Data retention (TTL) for the TelemetryPoint time-series collection.
 *
 * A native MongoDB time-series collection expires old data through its own
 * collection option, expireAfterSeconds (not through a TTL index):
 *
 *   db.createCollection('telemetry_points', { timeseries: {...}, expireAfterSeconds: 2592000 })
 *   db.runCommand({ collMod: 'telemetry_points', expireAfterSeconds: 2592000 })
 *
 * MongoDB removes data a whole bucket at a time, once every reading in the
 * bucket is older than the limit, so the newest readings of an expired bucket
 * can live up to one bucket span (an hour for 'seconds' granularity) longer, and
 * the background TTL monitor runs about once a minute. That is the storage
 * pruning behaviour, not a bug.
 *
 * Retention comes from, in this order: the expireAfterSeconds / retentionDays
 * option, the TELEMETRY_RETENTION_SECONDS or TELEMETRY_RETENTION_DAYS
 * environment variable, the 30 day default. The value 'off' (option or
 * environment) switches expiry off.
 *
 *  - applyRetentionPolicy(target)   creates the collection with the policy, or
 *                                   brings an existing one to it (collMod). Idempotent.
 *  - verifyRetentionPolicy(target)  reports whether the collection has the policy.
 *  - getRetentionPolicy(target)     reads the current setting.
 *
 * target is a native MongoDB Db, a mongoose connection, or a DatabaseConnection.
 * Without a live MongoDB (the in-memory fallback), nothing can expire by itself:
 * apply/verify say so, and pruneExpiredReadings() / startMemoryPruner() give the
 * in-memory collection the same age limit.
 */

const { COLLECTION_NAME, getCreateCollectionOptions } = require('../models/TelemetryPoint');

const DEFAULT_RETENTION_SECONDS = 2592000; // 30 days
const MAX_RETENTION_SECONDS = 2147483647; // MongoDB stores the value as a 32-bit integer
const SECONDS_PER_DAY = 86400;

function parseSetting(label, raw, unitSeconds) {
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'off') return { off: true };
  if (raw === null) return { off: true };
  const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (!Number.isFinite(n) || n <= 0 || n * unitSeconds > MAX_RETENTION_SECONDS) {
    throw new RangeError(`${label} must be a positive number up to ${MAX_RETENTION_SECONDS} seconds, or 'off' (got ${String(raw)})`);
  }
  return { seconds: Math.ceil(n * unitSeconds) };
}

/**
 * The retention to apply, in whole seconds, or null when expiry is off.
 * Throws RangeError for a value that is not a positive number or 'off'.
 */
function resolveRetentionSeconds(options = {}) {
  const env = process.env;
  let parsed;
  if (options.expireAfterSeconds !== undefined) parsed = parseSetting('expireAfterSeconds', options.expireAfterSeconds, 1);
  else if (options.retentionDays !== undefined) parsed = parseSetting('retentionDays', options.retentionDays, SECONDS_PER_DAY);
  else if (env.TELEMETRY_RETENTION_SECONDS) parsed = parseSetting('TELEMETRY_RETENTION_SECONDS', env.TELEMETRY_RETENTION_SECONDS, 1);
  else if (env.TELEMETRY_RETENTION_DAYS) parsed = parseSetting('TELEMETRY_RETENTION_DAYS', env.TELEMETRY_RETENTION_DAYS, SECONDS_PER_DAY);
  else parsed = { seconds: DEFAULT_RETENTION_SECONDS };
  return parsed.off ? null : parsed.seconds;
}

/** The native Db behind the target, or null when there is no live MongoDB (in-memory fallback). */
function resolveNativeDb(target) {
  if (!target) throw new TypeError('retention helpers need a MongoDB database or connection');
  if (typeof target.listCollections === 'function' && typeof target.command === 'function') return target;
  if (target.db && typeof target.db.listCollections === 'function') return target.db; // mongoose connection
  if ('nativeDb' in target) return target.nativeDb || null; // DatabaseConnection
  if (target.dbName !== undefined && target.collectionName !== undefined) {
    throw new TypeError('pass the MongoDB database (or connection), not a single collection');
  }
  if (typeof target.insertMany === 'function' || typeof target.deleteMany === 'function') return null; // in-memory collection
  throw new TypeError('target must be a MongoDB Db, a mongoose connection or a DatabaseConnection');
}

async function describeCollection(db, collectionName) {
  const [info] = await db.listCollections({ name: collectionName }).toArray();
  if (!info) return { exists: false, isTimeSeries: false, expireAfterSeconds: null };
  const opts = info.options || {};
  return {
    exists: true,
    isTimeSeries: info.type === 'timeseries',
    expireAfterSeconds: typeof opts.expireAfterSeconds === 'number' ? opts.expireAfterSeconds : null
  };
}

/** Current retention of the collection. { mode, exists, isTimeSeries, expireAfterSeconds (number or null = no expiry) } */
async function getRetentionPolicy(target, collectionName = COLLECTION_NAME) {
  const db = resolveNativeDb(target);
  if (!db) return { mode: 'memory', exists: false, isTimeSeries: false, expireAfterSeconds: null };
  return { mode: 'mongodb', ...(await describeCollection(db, collectionName)) };
}

/**
 * Brings the collection to the retention policy. Returns
 * { mode, action, expireAfterSeconds, previous } where action is 'created'
 * (collection did not exist), 'updated', 'unchanged' or 'skipped' (no live
 * MongoDB: nothing was changed). Throws when the collection exists but is not a
 * time-series collection.
 */
async function applyRetentionPolicy(target, options = {}) {
  const collectionName = options.collectionName || COLLECTION_NAME;
  const expireAfterSeconds = resolveRetentionSeconds(options);
  const db = resolveNativeDb(target);
  if (!db) return { mode: 'memory', action: 'skipped', expireAfterSeconds, previous: null };

  const current = await describeCollection(db, collectionName);
  if (!current.exists) {
    const createOptions = getCreateCollectionOptions();
    if (expireAfterSeconds !== null) createOptions.expireAfterSeconds = expireAfterSeconds;
    await db.createCollection(collectionName, createOptions);
    return { mode: 'mongodb', action: 'created', expireAfterSeconds, previous: null };
  }
  if (!current.isTimeSeries) {
    throw new Error(`collection ${collectionName} exists but is not a time-series collection; retention cannot be applied`);
  }
  if (current.expireAfterSeconds === expireAfterSeconds) {
    return { mode: 'mongodb', action: 'unchanged', expireAfterSeconds, previous: current.expireAfterSeconds };
  }
  await db.command({ collMod: collectionName, expireAfterSeconds: expireAfterSeconds === null ? 'off' : expireAfterSeconds });
  return { mode: 'mongodb', action: 'updated', expireAfterSeconds, previous: current.expireAfterSeconds };
}

/**
 * Reports whether the collection has the policy.
 * { ok, mode, expected, actual, exists, isTimeSeries, problems: [text] }
 */
async function verifyRetentionPolicy(target, options = {}) {
  const collectionName = options.collectionName || COLLECTION_NAME;
  const expected = resolveRetentionSeconds(options);
  const current = await getRetentionPolicy(target, collectionName);
  const problems = [];
  if (current.mode === 'memory') problems.push('no live MongoDB connection; the in-memory fallback cannot expire data by itself');
  else if (!current.exists) problems.push(`collection ${collectionName} does not exist`);
  else if (!current.isTimeSeries) problems.push(`collection ${collectionName} is not a time-series collection`);
  else if (current.expireAfterSeconds !== expected) {
    problems.push(`expireAfterSeconds is ${current.expireAfterSeconds === null ? 'not set' : current.expireAfterSeconds}, expected ${expected === null ? 'off' : expected}`);
  }
  return {
    ok: problems.length === 0,
    mode: current.mode,
    expected,
    actual: current.expireAfterSeconds,
    exists: current.exists,
    isTimeSeries: current.isTimeSeries,
    problems
  };
}

/**
 * In-memory fallback only: deletes readings older than the retention limit.
 * Returns the number removed. Does nothing when expiry is off.
 */
async function pruneExpiredReadings(collection, options = {}) {
  if (!collection || typeof collection.deleteMany !== 'function') throw new TypeError('pruneExpiredReadings needs a collection');
  const seconds = resolveRetentionSeconds(options);
  if (seconds === null) return 0;
  const now = options.now instanceof Date ? options.now.getTime() : Number.isFinite(options.now) ? options.now : Date.now();
  const result = await collection.deleteMany({ timestamp: { $lt: new Date(now - seconds * 1000) } });
  return result.deletedCount || 0;
}

/**
 * In-memory fallback only: prunes on a timer (default every 60 s, like the
 * MongoDB TTL monitor). The timer does not keep the process alive. Returns stop().
 */
function startMemoryPruner(collection, options = {}) {
  const intervalMs = options.intervalMs === undefined ? 60000 : options.intervalMs;
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new RangeError('intervalMs must be a positive number');
  resolveRetentionSeconds(options); // fail now, not on the first tick
  const timer = setInterval(() => {
    pruneExpiredReadings(collection, options).catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  DEFAULT_RETENTION_SECONDS,
  resolveRetentionSeconds,
  getRetentionPolicy,
  applyRetentionPolicy,
  verifyRetentionPolicy,
  pruneExpiredReadings,
  startMemoryPruner
};
