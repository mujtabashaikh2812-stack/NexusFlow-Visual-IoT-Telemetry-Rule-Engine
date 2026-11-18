'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DerivativeTransform,
  DERIVATIVE_MODES,
  TIME_UNITS,
  defaultDerivativeTransform,
} = require('../src/core/transforms/derivativeTransform');

test('DerivativeTransform: returns 0 on first baseline reading', () => {
  const transform = defaultDerivativeTransform;
  const state = {};
  const node = { id: 'tf_grad_1', config: { mode: 'instant', timeUnit: 'per_second' } };

  const result = transform.compute(node, 100, 1700000000000, state);
  assert.equal(result, 0);
  assert.ok(state.derivativeBuffers.has('tf_grad_1'));
});

test('DerivativeTransform: computes positive rate of change per second', () => {
  const transform = defaultDerivativeTransform;
  const state = {};
  const node = { id: 'tf_temp_rate', config: { mode: 'instant', timeUnit: 'per_second' } };

  const t0 = 1700000000000;
  transform.compute(node, 50, t0, state);

  // 2 seconds later, temperature rises to 70 (+20 deg in 2s -> 10 deg/sec)
  const t1 = t0 + 2000;
  const rate = transform.compute(node, 70, t1, state);
  assert.equal(rate, 10);
});

test('DerivativeTransform: computes negative rate of change for sudden pressure drop', () => {
  const transform = defaultDerivativeTransform;
  const state = {};
  const node = { id: 'tf_pressure_drop', config: { mode: 'instant', timeUnit: 'per_second' } };

  const t0 = 1700000000000;
  transform.compute(node, 150, t0, state);

  // 1 second later, pressure drops to 120 (-30 PSI in 1s -> -30 PSI/sec)
  const t1 = t0 + 1000;
  const rate = transform.compute(node, 120, t1, state);
  assert.equal(rate, -30);
});

test('DerivativeTransform: scales derivative to per_minute and per_hour time units', () => {
  const transform = defaultDerivativeTransform;
  const stateMin = {};
  const nodeMin = { id: 'tf_min', config: { mode: 'instant', timeUnit: 'per_minute' } };

  const t0 = 1700000000000;
  transform.compute(nodeMin, 10, t0, stateMin);

  // 2 units rise in 1 second -> 2 * 60 = 120 units / minute
  const rateMin = transform.compute(nodeMin, 12, t0 + 1000, stateMin);
  assert.equal(rateMin, 120);

  const stateHour = {};
  const nodeHour = { id: 'tf_hour', config: { mode: 'instant', timeUnit: 'per_hour' } };
  transform.compute(nodeHour, 10, t0, stateHour);

  // 1 unit rise in 1 second -> 3600 units / hour
  const rateHour = transform.compute(nodeHour, 11, t0 + 1000, stateHour);
  assert.equal(rateHour, 3600);
});

test('DerivativeTransform: computes absolute rate of change', () => {
  const transform = defaultDerivativeTransform;
  const state = {};
  const node = { id: 'tf_abs', config: { mode: 'absolute', timeUnit: 'per_second' } };

  const t0 = 1700000000000;
  transform.compute(node, 80, t0, state);

  // Drop of 25 in 1s -> -25, absolute mode returns +25
  const rate = transform.compute(node, 55, t0 + 1000, state);
  assert.equal(rate, 25);
});

test('DerivativeTransform: computes percentage rate of change per second', () => {
  const transform = defaultDerivativeTransform;
  const state = {};
  const node = { id: 'tf_pct', config: { mode: 'percentage', timeUnit: 'per_second' } };

  const t0 = 1700000000000;
  transform.compute(node, 200, t0, state);

  // 200 to 220 (+20 = +10%) in 2 seconds -> +5% per second
  const rate = transform.compute(node, 220, t0 + 2000, state);
  assert.equal(rate, 5);
});

test('DerivativeTransform: applies Exponential Moving Average (EMA) smoothing', () => {
  const transform = defaultDerivativeTransform;
  const state = {};
  const node = {
    id: 'tf_ema',
    config: { mode: 'smoothed', timeUnit: 'per_second', smoothingAlpha: 0.5 },
  };

  const t0 = 1700000000000;
  transform.compute(node, 100, t0, state);

  // Sample 1: +10 in 1s -> raw 10, smoothed = 10
  const rate1 = transform.compute(node, 110, t0 + 1000, state);
  assert.equal(rate1, 10);

  // Sample 2: sudden jump +30 in 1s -> raw 30, EMA = (0.5 * 30) + (0.5 * 10) = 20
  const rate2 = transform.compute(node, 140, t0 + 2000, state);
  assert.equal(rate2, 20);
});

test('DerivativeTransform: filters gradients by directional preference', () => {
  const transform = defaultDerivativeTransform;

  // Increasing only
  const stateInc = {};
  const nodeInc = { id: 'tf_inc', config: { direction: 'increasing' } };
  transform.compute(nodeInc, 100, 1000, stateInc);
  assert.equal(transform.compute(nodeInc, 90, 2000, stateInc), 0); // Drop is filtered to 0
  assert.equal(transform.compute(nodeInc, 110, 3000, stateInc), 20); // Rise is allowed

  // Decreasing only
  const stateDec = {};
  const nodeDec = { id: 'tf_dec', config: { direction: 'decreasing' } };
  transform.compute(nodeDec, 100, 1000, stateDec);
  assert.equal(transform.compute(nodeDec, 120, 2000, stateDec), 0); // Rise is filtered to 0
  assert.equal(transform.compute(nodeDec, 80, 3000, stateDec), -40); // Drop is allowed
});

test('DerivativeTransform: rejects sub-minimum delta time bursts (< minDeltaTimeMs)', () => {
  const transform = defaultDerivativeTransform;
  const state = {};
  const node = { id: 'tf_min_dt', config: { minDeltaTimeMs: 100 } };

  const t0 = 1700000000000;
  transform.compute(node, 100, t0, state);

  // 500ms later -> valid rate: +10 in 0.5s -> 20/s
  const rateValid = transform.compute(node, 110, t0 + 500, state);
  assert.equal(rateValid, 20);

  // 10ms later (burst) -> below 100ms threshold, returns previous gradient without divide-by-zero
  const rateBurst = transform.compute(node, 150, t0 + 510, state);
  assert.equal(rateBurst, 20);
});

test('DerivativeTransform: resetNode cleans up node memory buffer', () => {
  const transform = defaultDerivativeTransform;
  const state = {};
  const node = { id: 'tf_reset_test' };

  transform.compute(node, 50, 1000, state);
  assert.ok(state.derivativeBuffers.has('tf_reset_test'));

  transform.resetNode('tf_reset_test', state);
  assert.equal(state.derivativeBuffers.has('tf_reset_test'), false);
});
