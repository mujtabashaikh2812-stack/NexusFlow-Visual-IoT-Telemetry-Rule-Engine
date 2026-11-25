'use strict';

/**
 * Time-series compression ratio analyzer (Day 8).
 *
 * Answers one question: how many bytes does one stored reading really cost, and
 * how does that compare with the same reading sent as raw JSON?
 *
 *  - rawJsonBytesPerReading  average size of the reading as JSON text (what an
 *                            API or log line would carry).
 *  - bsonBytesPerReading     average size of the reading as BSON (what the driver
 *                            sends to MongoDB before any storage compression).
 *  - uncompressedBytesPerReading  MongoDB's own uncompressed data size per
 *                            reading ($collStats storageStats.size / count).
 *  - storedBytesPerReading   on-disk bytes per reading ($collStats
 *                            storageStats.storageSize / count). This is the
 *                            column/bucket compression result: MongoDB stores
 *                            time-series points in compressed buckets.
 *  - compressionRatio        rawJsonBytesPerReading / storedBytesPerReading.
 *                            Higher is better; 1 means no saving.
 *
 * Targets:
 *  - mongo-memory (default for a real answer) a throwaway local mongod from
 *                 mongodb-memory-server. Stored sizes are measured.
 *  - memory       the in-memory stand-in store. It has no on-disk compression,
 *                 so only the JSON and BSON sizes are real; stored sizes are null.
 *
 * Readings come from the same deterministic generator as the Day 6 stress test,
 * so the numbers are reproducible run to run.
 *
 * Environment (all optional):
 *   COMPRESSION_READINGS  readings to store          (default 20000)
 *   COMPRESSION_DEVICES   virtual devices            (default 100)
 *   COMPRESSION_TARGET    mongo-memory | memory      (default mongo-memory)
 *
 * Usage:  npm run bench:compression
 * Loading this file starts nothing; it only does work when run or called.
 */

const mongoose = require('mongoose');

const { COLLECTION_NAME, getTelemetryPointModel } = require('../database/models/TelemetryPoint');
const { InMemoryStore } = require('../database/inMemoryMock');
const { makeReading } = require('./ingestionStressTest');

const TARGETS = ['mongo-memory', 'memory'];
const DEFAULTS = Object.freeze({ readings: 20000, devices: 100, target: 'mongo-memory' });
const INSERT_CHUNK = 1000;

function requireWhole(label, value, min) {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${label} must be a whole number of at least ${min} (got ${value})`);
  }
  return value;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Explicit options win over environment variables, which win over defaults. */
function resolveConfig(options = {}) {
  const envWhole = (name, min) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return undefined;
    return requireWhole(name, Number(raw), min);
  };
  const pick = (explicit, fromEnv, dflt) => (explicit !== undefined ? explicit : fromEnv !== undefined ? fromEnv : dflt);
  const target = pick(options.target, process.env.COMPRESSION_TARGET || undefined, DEFAULTS.target);
  if (!TARGETS.includes(target)) throw new RangeError(`target must be one of ${TARGETS.join(', ')} (got ${target})`);
  return {
    readings: requireWhole('readings', pick(options.readings, envWhole('COMPRESSION_READINGS', 1), DEFAULTS.readings), 1),
    devices: requireWhole('devices', pick(options.devices, envWhole('COMPRESSION_DEVICES', 1), DEFAULTS.devices), 1),
    target
  };
}

/** The i-th reading of the run: devices take turns, one second per round. */
function readingAt(i, devices) {
  return makeReading(i % devices, Math.floor(i / devices));
}

/**
 * Sizes of a list of readings before storage: JSON text and BSON bytes, both
 * averaged per reading. Pure; needs no database.
 */
function measureRawSizes(docs) {
  if (!docs.length) throw new RangeError('measureRawSizes needs at least one reading');
  let jsonBytes = 0;
  let bsonBytes = 0;
  for (const doc of docs) {
    jsonBytes += Buffer.byteLength(JSON.stringify(doc), 'utf8');
    bsonBytes += mongoose.mongo.BSON.calculateObjectSize(doc);
  }
  return {
    readings: docs.length,
    rawJsonBytesPerReading: round2(jsonBytes / docs.length),
    bsonBytesPerReading: round2(bsonBytes / docs.length)
  };
}

/** Ratio of raw JSON to stored bytes; null when there is no stored size to compare. */
function compressionRatio(rawJsonBytesPerReading, storedBytesPerReading) {
  if (!storedBytesPerReading || storedBytesPerReading <= 0) return null;
  return round2(rawJsonBytesPerReading / storedBytesPerReading);
}

/**
 * Turns $collStats storageStats into per-reading figures. `readings` is the
 * number of logical readings stored (time-series storageStats has no count).
 * storageStats.size is the uncompressed data size; storageSize is the bytes
 * allocated on disk after compression. Pure.
 */
function storageToPerReading(storageStats, readings) {
  const count = Number(readings) || 0;
  if (count === 0) return { uncompressedBytesPerReading: null, storedBytesPerReading: null };
  return {
    uncompressedBytesPerReading: round2(Number(storageStats.size) / count),
    storedBytesPerReading: round2(Number(storageStats.storageSize) / count)
  };
}

async function writeChunks(collection, docs) {
  for (let start = 0; start < docs.length; start += INSERT_CHUNK) {
    const chunk = docs.slice(start, start + INSERT_CHUNK);
    const result = await collection.insertMany(chunk, { ordered: false });
    if (result.insertedCount !== chunk.length) {
      throw new Error(`only ${result.insertedCount} of ${chunk.length} readings were stored`);
    }
  }
}

/** Stores the readings in a real throwaway time-series collection and reads $collStats. */
async function measureMongoStorage(docs) {
  let MongoMemoryServer;
  try {
    ({ MongoMemoryServer } = require('mongodb-memory-server'));
  } catch (err) {
    throw new Error('mongodb-memory-server is not installed; use COMPRESSION_TARGET=memory or install dev dependencies');
  }
  const server = await MongoMemoryServer.create();
  const conn = mongoose.createConnection(server.getUri('nexusflow_compression_audit'));
  try {
    await conn.asPromise();
    await getTelemetryPointModel(conn).createCollection();
    const native = conn.db.collection(COLLECTION_NAME);
    await writeChunks(native, docs);
    // Flush to disk so storageSize reflects the stored (compressed) buckets, not only memory.
    await conn.db.admin().command({ fsync: 1 });
    const [row] = await native.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
    if (!row || !row.storageStats) throw new Error('storage statistics are not available for this collection');
    const st = row.storageStats;
    const storedReadings = await native.countDocuments({});
    return {
      storeLabel: 'throwaway local MongoDB time-series collection',
      storedReadings,
      ...storageToPerReading(st, storedReadings),
      bucketCount: st.timeseries && st.timeseries.bucketCount !== undefined ? Number(st.timeseries.bucketCount) : null
    };
  } finally {
    await conn.close().catch(() => {});
    await server.stop().catch(() => {});
  }
}

/** Stand-in store: counts the readings it holds; there is no on-disk compression to measure. */
async function measureMemoryStorage(docs) {
  const collection = new InMemoryStore().collection(COLLECTION_NAME);
  await writeChunks(collection, docs);
  return {
    storeLabel: 'in-memory store (no on-disk compression)',
    storedReadings: await collection.countDocuments({}),
    uncompressedBytesPerReading: null,
    storedBytesPerReading: null,
    bucketCount: null
  };
}

/**
 * Runs the audit and resolves a report. Never prints a connection string.
 */
async function runCompressionAudit(options = {}) {
  const cfg = resolveConfig(options);
  const docs = [];
  for (let i = 0; i < cfg.readings; i++) docs.push(readingAt(i, cfg.devices));

  const raw = measureRawSizes(docs);
  const stored = cfg.target === 'mongo-memory' ? await measureMongoStorage(docs) : await measureMemoryStorage(docs);
  const ratio = compressionRatio(raw.rawJsonBytesPerReading, stored.storedBytesPerReading);

  return {
    target: cfg.target,
    storeLabel: stored.storeLabel,
    devices: cfg.devices,
    readings: cfg.readings,
    storedReadings: stored.storedReadings,
    rawJsonBytesPerReading: raw.rawJsonBytesPerReading,
    bsonBytesPerReading: raw.bsonBytesPerReading,
    uncompressedBytesPerReading: stored.uncompressedBytesPerReading,
    storedBytesPerReading: stored.storedBytesPerReading,
    bucketCount: stored.bucketCount,
    compressionRatio: ratio,
    complete: stored.storedReadings === cfg.readings
  };
}

function printReport(r) {
  const line = (label, value) => console.log(`${label.padEnd(28)}: ${value}`);
  const show = (v) => (v === null || v === undefined ? 'n/a' : v);
  line('target', `${r.target} (${r.storeLabel})`);
  line('devices / readings', `${r.devices} / ${r.readings}`);
  line('readings stored', `${r.storedReadings} (${r.complete ? 'all' : 'NOT all'})`);
  line('raw JSON bytes per reading', r.rawJsonBytesPerReading);
  line('BSON bytes per reading', r.bsonBytesPerReading);
  line('uncompressed bytes/reading', show(r.uncompressedBytesPerReading));
  line('stored bytes per reading', show(r.storedBytesPerReading));
  line('buckets', show(r.bucketCount));
  line('compression ratio (JSON/stored)', show(r.compressionRatio));
  if (r.target === 'memory') {
    console.log('note                        : in-memory store has no on-disk compression; use COMPRESSION_TARGET=mongo-memory');
  }
}

if (require.main === module) {
  runCompressionAudit()
    .then((report) => {
      printReport(report);
      process.exitCode = report.complete ? 0 : 1;
    })
    .catch((err) => {
      console.log(`result : FAIL (${String(err.message).replace(/mongodb(\+srv)?:\/\/\S+/gi, 'mongodb://<hidden>')})`);
      process.exitCode = 1;
    });
}

module.exports = {
  runCompressionAudit,
  resolveConfig,
  readingAt,
  measureRawSizes,
  compressionRatio,
  storageToPerReading,
  DEFAULTS,
  TARGETS
};
