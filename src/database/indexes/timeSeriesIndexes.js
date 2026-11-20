'use strict';

/**
 * Compound indexes for the TelemetryPoint time-series collection.
 *
 *   { 'metadata.deviceId': 1,   timestamp: -1 }  - latest readings of one device
 *   { 'metadata.sensorType': 1, timestamp: -1 }  - latest readings of one sensor type
 *
 * ensureTimeSeriesIndexes() works on anything that answers createIndex() and
 * indexes(): a MongoDB driver collection, a collection from the in-memory
 * fallback store, or a DatabaseConnection (the collection is then looked up by
 * name). It is idempotent: running it twice builds nothing the second time.
 *
 * Note: on a real MongoDB server, create the time-series collection first
 * (TelemetryPoint model createCollection(), or createCollection with
 * getCreateCollectionOptions()). Creating an index on a missing collection
 * would make MongoDB create an ordinary one.
 */

const { COLLECTION_NAME } = require('../models/TelemetryPoint');

const TIME_SERIES_INDEXES = Object.freeze([
  Object.freeze({
    name: 'metadata.deviceId_1_timestamp_-1',
    key: Object.freeze({ 'metadata.deviceId': 1, timestamp: -1 })
  }),
  Object.freeze({
    name: 'metadata.sensorType_1_timestamp_-1',
    key: Object.freeze({ 'metadata.sensorType': 1, timestamp: -1 })
  })
]);

function resolveCollection(target, collectionName) {
  if (!target) throw new TypeError('ensureTimeSeriesIndexes needs a collection or a database connection');
  if (typeof target.createIndex === 'function' && typeof target.indexes === 'function') return target;
  if (typeof target.collection === 'function') return target.collection(collectionName);
  throw new TypeError('target must be a collection or expose collection(name)');
}

function sameKey(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** Existing indexes that match the definition by key pattern (whatever their name). */
async function findIndex(collection, def) {
  const existing = await collection.indexes();
  return existing.find((i) => i.key && sameKey(i.key, def.key)) || null;
}

/**
 * Builds any missing index. Returns { created: [names], existing: [names] }.
 */
async function ensureTimeSeriesIndexes(target, collectionName = COLLECTION_NAME) {
  const collection = resolveCollection(target, collectionName);
  const result = { created: [], existing: [] };
  for (const def of TIME_SERIES_INDEXES) {
    const found = await findIndex(collection, def);
    if (found) {
      result.existing.push(found.name);
      continue;
    }
    const name = await collection.createIndex({ ...def.key }, { name: def.name });
    result.created.push(name || def.name);
  }
  return result;
}

/** Reports which of the required indexes are present. Returns { ok, present: [names], missing: [names] }. */
async function verifyTimeSeriesIndexes(target, collectionName = COLLECTION_NAME) {
  const collection = resolveCollection(target, collectionName);
  const present = [];
  const missing = [];
  for (const def of TIME_SERIES_INDEXES) {
    const found = await findIndex(collection, def);
    if (found) present.push(found.name);
    else missing.push(def.name);
  }
  return { ok: missing.length === 0, present, missing };
}

module.exports = {
  TIME_SERIES_INDEXES,
  ensureTimeSeriesIndexes,
  verifyTimeSeriesIndexes
};
