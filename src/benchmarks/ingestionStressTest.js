'use strict';

/**
 * Ingestion stress test (Day 6): many virtual devices emitting telemetry at the
 * same time, pushed through the batch writer, with a report that proves whether
 * anything was lost.
 *
 *  - N worker threads each own a slice of the virtual devices. In every tick each
 *    worker emits one reading per device it owns, so all devices emit together.
 *  - Workers hand readings to the main thread in chunks. The main thread feeds
 *    them to a BatchWriter (bulkWrite, unordered), which writes to the target.
 *  - Targets:
 *      memory        (default) in-memory store. Runs anywhere, no network.
 *      mongo-memory  a throwaway local mongod from mongodb-memory-server (a dev
 *                    dependency). No credentials. Needs the server binary.
 *      env           the database in the MONGODB_URI environment variable, through
 *                    the connection manager. If it cannot be reached, the run uses
 *                    the in-memory fallback and the report says so.
 *  - After the run every reading is counted in the target. The report is
 *    "zero loss" only when every reading produced is stored, and every device
 *    has all of its readings.
 *
 * Environment (all optional, nothing is required):
 *   STRESS_DEVICES              virtual devices            (default 100)
 *   STRESS_WORKERS              worker threads             (default 4)
 *   STRESS_READINGS_PER_DEVICE  readings per device        (default 300)
 *   STRESS_TARGET               memory | mongo-memory | env (default memory)
 *   STRESS_TARGET_RATE          writes/sec goal for the report (default 5000)
 *   STRESS_VALIDATE             true | false, validate each reading (default true)
 *   STRESS_BATCH_SIZE           readings per bulk write (default TELEMETRY_BATCH_SIZE or 500)
 *   STRESS_VERIFY_CONTENT       true | false, read every stored reading back and compare it
 *                               with the reading that was produced (default false)
 *
 * Usage:  npm run bench:ingest
 * Loading this file starts nothing; it only does work when run or called.
 */

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const mongoose = require('mongoose');

const { BatchWriter } = require('../database/services/batchWriter');
const { COLLECTION_NAME, getTelemetryPointModel, getCreateCollectionOptions } = require('../database/models/TelemetryPoint');
const { ensureTimeSeriesIndexes } = require('../database/indexes/timeSeriesIndexes');
const { DatabaseConnection } = require('../database/dbConnection');
const { InMemoryStore } = require('../database/inMemoryMock');

const TARGETS = ['memory', 'mongo-memory', 'env'];
const DEFAULTS = Object.freeze({
  devices: 100,
  workers: 4,
  readingsPerDevice: 300,
  target: 'memory',
  targetRate: 5000,
  validate: true,
  batchSize: undefined,
  verifyContent: false
});
const LATENCY_GOAL_MS = 10; // sub-10ms write latency goal from the Mid-Project audit
const CHUNK_SIZE = 500; // readings per message from a worker to the main thread
const BASE_TIME = Date.UTC(2026, 10, 22, 0, 0, 0);
const SENSORS = Object.freeze({
  temperature: { unit: 'C', min: 15, span: 25 },
  pressure: { unit: 'bar', min: 1, span: 6 },
  vibration: { unit: 'mm/s', min: 0, span: 12 },
  flow: { unit: 'l/min', min: 10, span: 90 }
});
const SENSOR_ORDER = Object.keys(SENSORS);
const LOCATIONS = ['plant-a', 'plant-b', 'plant-c'];
const MODELS = ['SX-100', 'SX-200'];

// ------------------------------------------------------------ pure helpers

function deviceIdFor(index) {
  return `vdev-${String(index + 1).padStart(3, '0')}`;
}

/** Deterministic reading for device `index` at second `step`. Each device keeps one sensor type. */
function makeReading(index, step) {
  const sensorType = SENSOR_ORDER[index % SENSOR_ORDER.length];
  const spec = SENSORS[sensorType];
  const fraction = ((index * 7 + step * 3) % 100) / 100;
  return {
    timestamp: new Date(BASE_TIME + step * 1000),
    metadata: {
      deviceId: deviceIdFor(index),
      sensorType,
      location: LOCATIONS[index % LOCATIONS.length],
      model: MODELS[index % MODELS.length]
    },
    value: Math.round((spec.min + fraction * spec.span) * 100) / 100,
    unit: spec.unit
  };
}

/** Nearest-rank percentile of a list of numbers (null when the list is empty). */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return round2(sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function requireWhole(label, value, min) {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${label} must be a whole number of at least ${min} (got ${value})`);
  }
  return value;
}

function envValue(name) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}

function envWhole(name, min) {
  const raw = envValue(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return requireWhole(name, n, min);
}

/**
 * Turns options and environment into a checked configuration. Explicit options
 * win over environment variables, which win over defaults.
 */
function resolveConfig(options = {}) {
  const pick = (explicit, fromEnv, dflt) => (explicit !== undefined ? explicit : fromEnv !== undefined ? fromEnv : dflt);
  const devices = requireWhole('devices', pick(options.devices, envWhole('STRESS_DEVICES', 1), DEFAULTS.devices), 1);
  const requestedWorkers = requireWhole('workers', pick(options.workers, envWhole('STRESS_WORKERS', 1), DEFAULTS.workers), 1);
  const readingsPerDevice = requireWhole(
    'readingsPerDevice',
    pick(options.readingsPerDevice, envWhole('STRESS_READINGS_PER_DEVICE', 1), DEFAULTS.readingsPerDevice),
    1
  );
  const target = pick(options.target, envValue('STRESS_TARGET'), DEFAULTS.target);
  if (!TARGETS.includes(target)) throw new RangeError(`target must be one of ${TARGETS.join(', ')} (got ${target})`);
  const targetRate = requireWhole('targetRate', pick(options.targetRate, envWhole('STRESS_TARGET_RATE', 1), DEFAULTS.targetRate), 1);
  const validateRaw = pick(options.validate, envValue('STRESS_VALIDATE'), DEFAULTS.validate);
  const validate = typeof validateRaw === 'string' ? validateRaw.toLowerCase() !== 'false' : Boolean(validateRaw);
  const batchSize = pick(options.batchSize, envWhole('STRESS_BATCH_SIZE', 1), DEFAULTS.batchSize);
  const verifyRaw = pick(options.verifyContent, envValue('STRESS_VERIFY_CONTENT'), DEFAULTS.verifyContent);
  const verifyContent = typeof verifyRaw === 'string' ? verifyRaw.toLowerCase() === 'true' : Boolean(verifyRaw);
  return {
    devices,
    workers: Math.min(requestedWorkers, devices), // never more workers than devices
    readingsPerDevice,
    target,
    targetRate,
    validate,
    batchSize,
    verifyContent
  };
}

function readingKey(deviceId, timestampMs) {
  return `${deviceId}|${timestampMs}`;
}

/** Every field that a reading carries, in one comparable string (field order and _id ignored). */
function canonicalReading(doc) {
  const m = doc.metadata || {};
  return JSON.stringify([
    m.deviceId,
    m.sensorType,
    m.location,
    m.model,
    new Date(doc.timestamp).getTime(),
    doc.value,
    doc.unit === undefined ? null : doc.unit
  ]);
}

/**
 * Compares the readings found in the store with the readings that were produced
 * for `devices` x `readingsPerDevice`. Pure: no database needed.
 *
 *  - mismatched: a stored reading has the right device and time but other content
 *  - unexpected: a stored reading matches no produced reading
 *  - duplicates: the same produced reading is stored more than once
 *  - missing:    a produced reading is not stored at all
 *  - corrupted:  mismatched + unexpected + duplicates (zero means no corruption)
 */
function verifyStoredReadings(storedDocs, devices, readingsPerDevice) {
  const expected = new Map();
  for (let d = 0; d < devices; d++) {
    for (let s = 0; s < readingsPerDevice; s++) {
      const reading = makeReading(d, s);
      expected.set(readingKey(reading.metadata.deviceId, reading.timestamp.getTime()), canonicalReading(reading));
    }
  }
  const matched = new Set();
  let mismatched = 0;
  let unexpected = 0;
  let duplicates = 0;
  for (const doc of storedDocs) {
    const key = readingKey(doc.metadata && doc.metadata.deviceId, new Date(doc.timestamp).getTime());
    if (!expected.has(key)) {
      unexpected++;
    } else if (matched.has(key)) {
      duplicates++;
    } else if (canonicalReading(doc) !== expected.get(key)) {
      mismatched++;
      matched.add(key);
    } else {
      matched.add(key);
    }
  }
  const missing = expected.size - matched.size;
  return {
    checked: storedDocs.length,
    expected: expected.size,
    mismatched,
    unexpected,
    duplicates,
    missing,
    corrupted: mismatched + unexpected + duplicates
  };
}

/** Splits device indexes 0..devices-1 into contiguous slices, one per worker. */
function sliceDevices(devices, workers) {
  const slices = [];
  for (let w = 0; w < workers; w++) {
    const first = Math.floor((w * devices) / workers);
    const last = Math.floor(((w + 1) * devices) / workers);
    slices.push({ firstDevice: first, deviceCount: last - first });
  }
  return slices;
}

// ------------------------------------------------------------ targets

/** Opens the target and returns { collection, storeMode, label, close(), cleanup() }. */
async function openTarget(cfg) {
  const runName = `${COLLECTION_NAME}_bench_${Date.now()}`;

  if (cfg.target === 'memory') {
    const store = new InMemoryStore();
    return {
      collection: store.collection(runName),
      storeMode: 'memory',
      serverVersion: null,
      label: 'in-memory store',
      close: async () => {}
    };
  }

  if (cfg.target === 'mongo-memory') {
    let MongoMemoryServer;
    try {
      ({ MongoMemoryServer } = require('mongodb-memory-server'));
    } catch (err) {
      throw new Error('mongodb-memory-server is not installed; use STRESS_TARGET=memory or install dev dependencies');
    }
    const server = await MongoMemoryServer.create();
    const conn = mongoose.createConnection(server.getUri('nexusflow_ingest_bench'));
    try {
      await conn.asPromise();
      await getTelemetryPointModel(conn).createCollection();
      const native = conn.db.collection(COLLECTION_NAME);
      await ensureTimeSeriesIndexes(native);
      const info = await conn.db.admin().command({ buildInfo: 1 }).catch(() => null);
      return {
        collection: native,
        storeMode: 'mongodb',
        serverVersion: info && info.version ? String(info.version) : null,
        label: 'throwaway local MongoDB',
        close: async () => {
          await conn.close();
          await server.stop();
        }
      };
    } catch (err) {
      await conn.close().catch(() => {});
      await server.stop().catch(() => {});
      throw err;
    }
  }

  // env: the database named by MONGODB_URI, through the connection manager.
  const db = new DatabaseConnection({ maxRetries: 1, baseDelayMs: 50, maxDelayMs: 200 });
  await db.connect();
  const storeMode = db.getStats().mode;
  if (storeMode === 'mongodb' && db.nativeDb) {
    await db.nativeDb.createCollection(runName, getCreateCollectionOptions()).catch(() => {});
  }
  return {
    collection: db.collection(runName),
    storeMode,
    serverVersion: null,
    label: storeMode === 'mongodb' ? 'MongoDB from environment' : 'in-memory fallback (MongoDB not reachable)',
    close: async () => {
      await db.close();
    }
  };
}

// ------------------------------------------------------------ main run

/**
 * Runs the stress test and resolves a report. Never prints a connection string.
 * The caller decides what to show.
 */
async function runIngestionStress(options = {}) {
  const cfg = resolveConfig(options);
  const target = await openTarget(cfg);
  const latencies = [];
  let report;
  try {
    // Times every bulk write. Each latency is for one batch of readings, not one reading.
    const timed = {
      bulkWrite: async (operations, bulkOptions) => {
        const t0 = performance.now();
        try {
          return await target.collection.bulkWrite(operations, bulkOptions);
        } finally {
          latencies.push(performance.now() - t0);
        }
      }
    };
    const writer = new BatchWriter(timed, {
      validate: cfg.validate,
      batchSize: cfg.batchSize,
      logger: options.logger || console
    });

    const slices = sliceDevices(cfg.devices, cfg.workers);
    let produced = 0;
    let accepted = 0;
    let rejected = 0;
    const started = performance.now();

    await Promise.all(
      slices.map(
        (slice) =>
          new Promise((resolve, reject) => {
            let finished = false;
            const worker = new Worker(__filename, {
              workerData: { kind: 'stress-worker', ...slice, readingsPerDevice: cfg.readingsPerDevice }
            });
            worker.on('message', (msg) => {
              if (msg.type === 'chunk') {
                const r = writer.addMany(msg.readings);
                accepted += r.accepted;
                rejected += r.rejected;
              } else if (msg.type === 'done') {
                produced += msg.produced;
                finished = true;
                resolve();
              }
            });
            worker.on('error', (err) => reject(new Error(`worker failed: ${err.message}`)));
            worker.on('exit', (code) => {
              if (!finished) reject(new Error(`worker stopped early with code ${code}`));
            });
          })
      )
    );

    // Everything produced has been handed to the writer. Flush and stop.
    const closeResult = await writer.close();
    const elapsedMs = performance.now() - started;
    const stats = writer.getStats();

    // Count what is really stored: this is the authority for "zero loss".
    const stored = await target.collection.countDocuments({});
    let devicesComplete = 0;
    for (let i = 0; i < cfg.devices; i++) {
      const n = await target.collection.countDocuments({ 'metadata.deviceId': deviceIdFor(i) });
      if (n === cfg.readingsPerDevice) devicesComplete++;
    }
    // Optional content check: every stored reading must equal the one that was produced.
    const content = cfg.verifyContent
      ? verifyStoredReadings(await target.collection.find({}).toArray(), cfg.devices, cfg.readingsPerDevice)
      : null;

    const writesPerSec = elapsedMs > 0 ? Math.round((stats.written / (elapsedMs / 1000)) * 10) / 10 : 0;
    const lost = produced - stored;
    const zeroLoss =
      lost === 0 && rejected === 0 && stats.dropped === 0 && stats.failed === 0 && stats.unflushed === 0 && closeResult.remaining === 0;
    const p99 = percentile(latencies, 99);

    report = {
      target: cfg.target,
      storeLabel: target.label,
      storeMode: target.storeMode,
      devices: cfg.devices,
      workers: cfg.workers,
      readingsPerDevice: cfg.readingsPerDevice,
      produced,
      accepted,
      rejected,
      stored,
      lost,
      dropped: stats.dropped,
      failed: stats.failed,
      unflushed: closeResult.remaining,
      devicesComplete,
      zeroLoss,
      elapsedMs: round2(elapsedMs),
      writesPerSec,
      targetRate: cfg.targetRate,
      meetsRate: writesPerSec >= cfg.targetRate,
      batches: latencies.length,
      batchLatencyMs: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99,
        max: latencies.length ? round2(Math.max(...latencies)) : null,
        first: latencies.length ? round2(latencies[0]) : null // the first bulk write to finish in this run
      },
      latencyGoalMs: LATENCY_GOAL_MS,
      meetsLatency: p99 !== null && p99 <= LATENCY_GOAL_MS,
      serverVersion: target.serverVersion,
      contentVerified: content !== null,
      corruptedReadings: content ? content.corrupted : null,
      missingReadings: content ? content.missing : null,
      passed:
        zeroLoss &&
        devicesComplete === cfg.devices &&
        produced === cfg.devices * cfg.readingsPerDevice &&
        (content === null || content.corrupted === 0)
    };
  } finally {
    await target.close().catch(() => {});
  }
  return report;
}

function printReport(r) {
  const line = (label, value) => console.log(`${label.padEnd(22)}: ${value}`);
  line('target', `${r.target} (${r.storeLabel})`);
  line('devices / workers', `${r.devices} / ${r.workers}`);
  line('readings per device', r.readingsPerDevice);
  line('readings produced', r.produced);
  line('readings stored', r.stored);
  line('lost / dropped / failed', `${r.lost} / ${r.dropped} / ${r.failed}`);
  line('devices complete', `${r.devicesComplete} of ${r.devices}`);
  line('elapsed (ms)', r.elapsedMs);
  line('writes per second', `${r.writesPerSec} (goal ${r.targetRate}: ${r.meetsRate ? 'met' : 'not met'})`);
  line('batches written', r.batches);
  line('batch latency ms', `p50 ${r.batchLatencyMs.p50} / p95 ${r.batchLatencyMs.p95} / p99 ${r.batchLatencyMs.p99} (goal ${r.latencyGoalMs}: ${r.meetsLatency ? 'met' : 'not met'})`);
  line('zero loss', r.zeroLoss ? 'yes' : 'no');
  if (r.contentVerified) line('corrupted readings', `${r.corruptedReadings} (every stored reading compared with the one produced)`);
  line('result', r.passed ? 'PASS' : 'FAIL');
  if (r.target === 'env' && r.storeMode !== 'mongodb') {
    console.log('note                  : MongoDB was not reachable, so this run used the in-memory fallback');
  }
  if (r.target === 'memory') {
    console.log('note                  : in-memory numbers measure the stand-in store, not MongoDB; use STRESS_TARGET=mongo-memory');
  }
}

// ------------------------------------------------------------ worker side

function runStressWorker(job) {
  let buffer = [];
  let produced = 0;
  for (let step = 0; step < job.readingsPerDevice; step++) {
    for (let d = job.firstDevice; d < job.firstDevice + job.deviceCount; d++) {
      buffer.push(makeReading(d, step));
      if (buffer.length >= CHUNK_SIZE) {
        parentPort.postMessage({ type: 'chunk', readings: buffer });
        produced += buffer.length;
        buffer = [];
      }
    }
  }
  if (buffer.length) {
    parentPort.postMessage({ type: 'chunk', readings: buffer });
    produced += buffer.length;
  }
  parentPort.postMessage({ type: 'done', produced });
}

// ------------------------------------------------------------ entry points

if (!isMainThread && workerData && workerData.kind === 'stress-worker') {
  runStressWorker(workerData);
} else if (isMainThread && require.main === module) {
  runIngestionStress()
    .then((report) => {
      printReport(report);
      process.exitCode = report.passed ? 0 : 1;
    })
    .catch((err) => {
      console.log(`result : FAIL (${String(err.message).replace(/mongodb(\+srv)?:\/\/\S+/gi, 'mongodb://<hidden>')})`);
      process.exitCode = 1;
    });
}

module.exports = {
  runIngestionStress,
  resolveConfig,
  makeReading,
  deviceIdFor,
  percentile,
  sliceDevices,
  verifyStoredReadings,
  DEFAULTS,
  TARGETS,
  LATENCY_GOAL_MS
};
