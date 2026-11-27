'use strict';

/**
 * Mid-Project Ingestion Audit (Day 11): runs the multi-worker ingestion stress
 * test several times and records a scorecard against the sheet's goals:
 *
 *  - throughput:      5,000+ writes/second, in every run
 *  - zero loss:       every produced reading stored, none dropped, failed or left behind
 *  - zero corruption: every stored reading read back and equal to the one produced
 *  - write latency:   p99 of one bulk write (up to 500 readings) at or below 10 ms, in every run
 *
 * A criterion passes only when every run meets it. The verdict is FAIL if any
 * criterion fails; nothing is rounded or re-run to make a number pass.
 *
 * The scorecard is written as JSON to docs/audit/mid-project-ingestion-scorecard.json
 * (or AUDIT_OUT). It never contains a connection string.
 *
 * Environment (all optional):
 *   AUDIT_RUNS    number of full runs (default 3)
 *   AUDIT_TARGET  memory | mongo-memory | env (default mongo-memory)
 *   AUDIT_OUT     scorecard file path (default docs/audit/mid-project-ingestion-scorecard.json)
 *
 * Usage:  npm run audit:ingest
 * Loading this file starts nothing; it only does work when run or called.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runIngestionStress, LATENCY_GOAL_MS, TARGETS } = require('./ingestionStressTest');

const DEFAULT_OUT = path.join(__dirname, '..', '..', 'docs', 'audit', 'mid-project-ingestion-scorecard.json');
const DEFAULTS = Object.freeze({
  devices: 100,
  workers: 4,
  readingsPerDevice: 300,
  runs: 3,
  target: 'mongo-memory',
  throughputGoal: 5000,
  batchSize: 500
});

function whole(label, value, min) {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${label} must be a whole number of at least ${min} (got ${value})`);
  }
  return value;
}

/** Checked audit settings. Explicit options win over AUDIT_* environment variables, which win over defaults. */
function resolveAuditConfig(options = {}) {
  const env = process.env;
  const envNum = (name) => (env[name] === undefined || env[name] === '' ? undefined : Number(env[name]));
  const pick = (explicit, fromEnv, dflt) => (explicit !== undefined ? explicit : fromEnv !== undefined ? fromEnv : dflt);
  const target = pick(options.target, env.AUDIT_TARGET || undefined, DEFAULTS.target);
  if (!TARGETS.includes(target)) throw new RangeError(`target must be one of ${TARGETS.join(', ')} (got ${target})`);
  const devices = whole('devices', pick(options.devices, envNum('AUDIT_DEVICES'), DEFAULTS.devices), 1);
  return {
    devices,
    workers: Math.min(whole('workers', pick(options.workers, undefined, DEFAULTS.workers), 1), devices),
    readingsPerDevice: whole('readingsPerDevice', pick(options.readingsPerDevice, envNum('AUDIT_READINGS_PER_DEVICE'), DEFAULTS.readingsPerDevice), 1),
    runs: whole('runs', pick(options.runs, envNum('AUDIT_RUNS'), DEFAULTS.runs), 1),
    target,
    throughputGoal: whole('throughputGoal', pick(options.throughputGoal, undefined, DEFAULTS.throughputGoal), 1),
    batchSize: whole('batchSize', pick(options.batchSize, undefined, DEFAULTS.batchSize), 1),
    latencyGoalMs: LATENCY_GOAL_MS,
    outFile: pick(options.outFile, env.AUDIT_OUT || undefined, DEFAULT_OUT)
  };
}

/** The part of one stress-run report that the scorecard keeps. */
function summariseRun(index, report) {
  return {
    run: index,
    storeMode: report.storeMode,
    serverVersion: report.serverVersion,
    produced: report.produced,
    stored: report.stored,
    lost: report.lost,
    dropped: report.dropped,
    failed: report.failed,
    unflushed: report.unflushed,
    devicesComplete: report.devicesComplete,
    corruptedReadings: report.corruptedReadings,
    missingReadings: report.missingReadings,
    elapsedMs: report.elapsedMs,
    writesPerSec: report.writesPerSec,
    batches: report.batches,
    batchLatencyMs: report.batchLatencyMs,
    zeroLoss: report.zeroLoss,
    passed: report.passed
  };
}

/**
 * Pure: turns the run records into criteria and a verdict. Throws when there are no runs.
 * `config` is the resolved audit config, `environment` describes the machine.
 */
function buildScorecard(runs, config, environment = {}, generatedAt = new Date().toISOString()) {
  if (!Array.isArray(runs) || runs.length === 0) throw new RangeError('the audit needs at least one run');
  const readingsPerRun = config.devices * config.readingsPerDevice;
  const sum = (key) => runs.reduce((acc, r) => acc + (r[key] || 0), 0);
  const lowestRate = Math.min(...runs.map((r) => r.writesPerSec));
  const worstP99 = runs.every((r) => r.batchLatencyMs && r.batchLatencyMs.p99 !== null)
    ? Math.max(...runs.map((r) => r.batchLatencyMs.p99))
    : null;

  const criteria = [
    {
      name: 'throughput',
      goal: `at least ${config.throughputGoal} writes per second, in every run`,
      measured: lowestRate,
      unit: 'writes/sec (lowest run)',
      passed: runs.every((r) => r.writesPerSec >= config.throughputGoal)
    },
    {
      name: 'zeroLoss',
      goal: 'every produced reading stored; none lost, dropped, failed or left unflushed',
      measured: sum('lost') + sum('dropped') + sum('failed') + sum('unflushed'),
      unit: 'readings (total over all runs)',
      passed: runs.every((r) => r.zeroLoss === true && r.produced === readingsPerRun && r.stored === readingsPerRun)
    },
    {
      name: 'zeroCorruption',
      goal: 'every stored reading read back equal to the reading produced; none missing or duplicated',
      measured: sum('corruptedReadings') + sum('missingReadings'),
      unit: 'readings (total over all runs)',
      passed: runs.every((r) => r.corruptedReadings === 0 && r.missingReadings === 0)
    },
    {
      name: 'writeLatency',
      goal: `p99 of one bulk write at or below ${config.latencyGoalMs} ms, in every run`,
      measured: worstP99,
      unit: 'ms (worst run p99)',
      passed: worstP99 !== null && runs.every((r) => r.batchLatencyMs.p99 <= config.latencyGoalMs)
    }
  ];

  const caveats = [
    config.target === 'mongo-memory'
      ? 'Measured against a throwaway local mongod started by mongodb-memory-server for each run. It is not a production or shared MongoDB server.'
      : config.target === 'memory'
        ? 'Measured against the in-memory stand-in store, not MongoDB.'
        : 'Measured against the database named by the environment, when it was reachable.',
    'Latency is per bulk write of up to the batch size, not per single reading.',
    'Writes per second is readings stored divided by the wall-clock time of the whole run, including worker start-up.',
    'All runs were made on one machine; results depend on that machine (see environment).'
  ];
  if (runs.some((r) => r.storeMode !== 'mongodb')) {
    caveats.push('At least one run did not write to MongoDB (storeMode is not mongodb); see runs[].storeMode.');
  }
  if (runs.every((r) => r.batchLatencyMs && r.batchLatencyMs.first !== null && r.batchLatencyMs.first === r.batchLatencyMs.max)) {
    caveats.push(
      'In every run the slowest bulk write was the first one to finish in that run (see runs[].batchLatencyMs.first). ' +
        'The cause of that first write was not established, so the latency criterion is reported as measured.'
    );
  }

  return {
    audit: 'Mid-Project Ingestion Audit (Day 11)',
    generatedAt,
    verdict: criteria.every((c) => c.passed) ? 'PASS' : 'FAIL',
    criteria,
    config: {
      devices: config.devices,
      workers: config.workers,
      readingsPerDevice: config.readingsPerDevice,
      readingsPerRun,
      runs: runs.length,
      target: config.target,
      batchSize: config.batchSize,
      throughputGoal: config.throughputGoal,
      latencyGoalMs: config.latencyGoalMs
    },
    environment,
    runs,
    caveats
  };
}

/**
 * Runs the audit and (unless write is false) writes the scorecard JSON.
 * Resolves the scorecard object. Never prints a connection string.
 */
async function runAudit(options = {}) {
  const config = resolveAuditConfig(options);
  const quiet = options.logger || console;
  const runs = [];
  for (let i = 1; i <= config.runs; i++) {
    const report = await runIngestionStress({
      devices: config.devices,
      workers: config.workers,
      readingsPerDevice: config.readingsPerDevice,
      target: config.target,
      targetRate: config.throughputGoal,
      batchSize: config.batchSize,
      validate: true,
      verifyContent: true,
      logger: quiet
    });
    runs.push(summariseRun(i, report));
  }
  const environment = {
    node: process.version,
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    serverVersion: runs[0].serverVersion
  };
  const scorecard = buildScorecard(runs, config, environment);
  if (options.write !== false) {
    fs.mkdirSync(path.dirname(config.outFile), { recursive: true });
    fs.writeFileSync(config.outFile, `${JSON.stringify(scorecard, null, 2)}\n`);
    // Read it back: the file on disk must parse and say the same verdict.
    const back = JSON.parse(fs.readFileSync(config.outFile, 'utf8'));
    if (back.verdict !== scorecard.verdict || back.runs.length !== runs.length) {
      throw new Error('scorecard file does not match the run results');
    }
  }
  return scorecard;
}

function printScorecard(card, outFile) {
  const line = (label, value) => console.log(`${label.padEnd(22)}: ${value}`);
  line('target', `${card.config.target}`);
  line('runs x readings', `${card.config.runs} x ${card.config.readingsPerRun}`);
  card.runs.forEach((r) =>
    line(`run ${r.run}`, `${r.writesPerSec} writes/sec, stored ${r.stored}/${r.produced}, corrupted ${r.corruptedReadings}, p99 ${r.batchLatencyMs.p99} ms`)
  );
  card.criteria.forEach((c) => line(c.name, `${c.measured} ${c.unit} - ${c.passed ? 'met' : 'NOT met'} (goal: ${c.goal})`));
  line('verdict', card.verdict);
  if (outFile) line('scorecard file', outFile);
}

module.exports = {
  runAudit,
  buildScorecard,
  resolveAuditConfig,
  summariseRun,
  DEFAULTS,
  DEFAULT_OUT
};

if (require.main === module) {
  const config = resolveAuditConfig();
  runAudit()
    .then((card) => {
      printScorecard(card, config.outFile);
      process.exitCode = card.verdict === 'PASS' ? 0 : 1;
    })
    .catch((err) => {
      console.log(`verdict : FAIL (${String(err.message).replace(/mongodb(\+srv)?:\/\/\S+/gi, 'mongodb://<hidden>')})`);
      process.exitCode = 1;
    });
}
