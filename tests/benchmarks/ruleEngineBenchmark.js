'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RuleEvaluator } = require('../../src/core/ruleEvaluator');
const { defaultRuleParser } = require('../../src/core/ruleParser');

/**
 * NexusFlow Mid-Project Performance Benchmark
 * Target: Sub-1ms execution latency per telemetry reading across 50 active reactive rules
 * Workload: 10,000 simulated continuous IoT telemetry readings
 */

function generateSyntheticRules(count = 50) {
  const rules = [];
  const sensorTypes = ['temperature', 'pressure', 'vibration', 'humidity', 'voltage'];

  for (let i = 1; i <= count; i++) {
    const sensorType = sensorTypes[i % sensorTypes.length];
    const threshold = 50 + (i % 40);
    const deviceId = `device-${(i % 10) + 1}`;

    const nodes = [
      {
        id: `node_source_${i}`,
        type: 'sourceNode',
        data: {
          category: 'source',
          deviceId,
          sensorType,
        },
      },
    ];

    const edges = [];

    if (i % 3 === 0) {
      // Moving Average transform pipeline
      nodes.push({
        id: `node_tr_${i}`,
        type: 'transformNode',
        data: {
          category: 'transform',
          transformType: 'moving_average',
          windowSize: 5,
        },
      });
      edges.push({ id: `e1_${i}`, source: `node_source_${i}`, target: `node_tr_${i}` });
      nodes.push({
        id: `node_cond_${i}`,
        type: 'conditionNode',
        data: {
          category: 'condition',
          operator: '>',
          threshold,
        },
      });
      edges.push({ id: `e2_${i}`, source: `node_tr_${i}`, target: `node_cond_${i}` });
    } else if (i % 3 === 1) {
      // Derivative gradient transform pipeline
      nodes.push({
        id: `node_tr_${i}`,
        type: 'transformNode',
        data: {
          category: 'transform',
          transformType: 'derivative',
          mode: 'instant',
          timeUnit: 'per_second',
        },
      });
      edges.push({ id: `e1_${i}`, source: `node_source_${i}`, target: `node_tr_${i}` });
      nodes.push({
        id: `node_cond_${i}`,
        type: 'conditionNode',
        data: {
          category: 'condition',
          operator: '>',
          threshold: 5,
        },
      });
      edges.push({ id: `e2_${i}`, source: `node_tr_${i}`, target: `node_cond_${i}` });
    } else {
      // Direct Condition
      nodes.push({
        id: `node_cond_${i}`,
        type: 'conditionNode',
        data: {
          category: 'condition',
          operator: '>',
          threshold,
        },
      });
      edges.push({ id: `e1_${i}`, source: `node_source_${i}`, target: `node_cond_${i}` });
    }

    nodes.push({
      id: `node_act_${i}`,
      type: 'actionNode',
      data: {
        category: 'action',
        actionType: 'alert',
        message: `High alert on rule ${i}`,
        cooldownSeconds: 0,
      },
    });
    edges.push({ id: `e_act_${i}`, source: `node_cond_${i}`, target: `node_act_${i}` });

    const rawGraph = {
      id: `bench_rule_${i}`,
      name: `Benchmark Pipeline ${i}`,
      nodes,
      edges,
    };

    const ast = defaultRuleParser.parse(rawGraph);
    rules.push(ast);
  }

  return rules;
}

function runBenchmark(evaluator, rules, readingsCount = 10000) {
  for (const rule of rules) {
    evaluator.registerRule(rule);
  }

  const sensorTypes = ['temperature', 'pressure', 'vibration', 'humidity', 'voltage'];
  const latenciesNs = new BigInt64Array(readingsCount);
  let triggeredAlertsTotal = 0;

  const memBefore = process.memoryUsage();
  const overallStart = process.hrtime.bigint();

  for (let i = 0; i < readingsCount; i++) {
    const reading = {
      deviceId: `device-${(i % 10) + 1}`,
      sensorType: sensorTypes[i % sensorTypes.length],
      value: 20 + (i % 80) + Math.random() * 5,
      timestamp: new Date(Date.now() - (readingsCount - i) * 100).toISOString(),
      unit: 'standard',
    };

    const t0 = process.hrtime.bigint();
    const result = evaluator.evaluate(reading);
    const t1 = process.hrtime.bigint();

    latenciesNs[i] = t1 - t0;
    triggeredAlertsTotal += result.triggeredAlerts ? result.triggeredAlerts.length : 0;
  }

  const overallEnd = process.hrtime.bigint();
  const memAfter = process.memoryUsage();

  const totalTimeMs = Number(overallEnd - overallStart) / 1e6;
  const avgLatencyMs = totalTimeMs / readingsCount;
  const throughputRps = Math.round((readingsCount / (totalTimeMs / 1000)));

  // Calculate percentiles
  const sortedLatencies = Array.from(latenciesNs).map((ns) => Number(ns) / 1e6).sort((a, b) => a - b);
  const p50 = sortedLatencies[Math.floor(readingsCount * 0.50)];
  const p90 = sortedLatencies[Math.floor(readingsCount * 0.90)];
  const p95 = sortedLatencies[Math.floor(readingsCount * 0.95)];
  const p99 = sortedLatencies[Math.floor(readingsCount * 0.99)];
  const max = sortedLatencies[readingsCount - 1];

  const heapDiffMb = (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024);

  return {
    readingsCount,
    rulesCount: rules.length,
    totalTimeMs: Math.round(totalTimeMs * 100) / 100,
    avgLatencyMs: Math.round(avgLatencyMs * 10000) / 10000,
    avgLatencyMicroseconds: Math.round(avgLatencyMs * 1000 * 10) / 10,
    throughputRps,
    p50Ms: Math.round(p50 * 10000) / 10000,
    p90Ms: Math.round(p90 * 10000) / 10000,
    p95Ms: Math.round(p95 * 10000) / 10000,
    p99Ms: Math.round(p99 * 10000) / 10000,
    maxMs: Math.round(max * 10000) / 10000,
    heapDiffMb: Math.round(heapDiffMb * 100) / 100,
    triggeredAlertsTotal,
  };
}

test('Benchmark: Rule Engine processes 10,000 readings across 50 rules under 1ms latency', () => {
  const evaluator = new RuleEvaluator();
  const rules = generateSyntheticRules(50);

  console.log(`[Benchmark] Starting stress test: 10,000 readings across 50 active rules...`);
  const results = runBenchmark(evaluator, rules, 10000);
  console.log(`[Benchmark Results]`);
  console.table(results);

  // Assertions against SLA targets
  assert.equal(results.readingsCount, 10000);
  assert.equal(results.rulesCount, 50);
  assert.ok(
    results.avgLatencyMs < 1.0,
    `Target failed: Expected average latency < 1.0ms, got ${results.avgLatencyMs}ms`
  );
  assert.ok(
    results.p95Ms < 5.0,
    `Target failed: Expected p95 latency < 5.0ms, got ${results.p95Ms}ms`
  );
  assert.ok(
    results.throughputRps > 1000,
    `Target failed: Expected throughput > 1,000 req/s, got ${results.throughputRps} req/s`
  );
});

module.exports = {
  generateSyntheticRules,
  runBenchmark,
};
