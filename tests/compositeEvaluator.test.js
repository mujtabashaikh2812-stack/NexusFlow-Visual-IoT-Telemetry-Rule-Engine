'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CompositeEvaluator,
  CompositeEvaluatorError,
  LOGIC_OPERATORS,
  defaultCompositeEvaluator,
} = require('../src/core/compositeEvaluator');

test('CompositeEvaluator: evaluates AND gate correctly across inputs', () => {
  const evaluator = defaultCompositeEvaluator;

  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.AND, [true, true, true]), true);
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.AND, [true, false, true]), false);
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.AND, [false, false]), false);
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.AND, []), false);
});

test('CompositeEvaluator: evaluates OR gate correctly across inputs', () => {
  const evaluator = defaultCompositeEvaluator;

  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.OR, [false, true, false]), true);
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.OR, [false, false, false]), false);
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.OR, [true, true]), true);
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.OR, []), false);
});

test('CompositeEvaluator: evaluates NOT gate inverting inputs', () => {
  const evaluator = defaultCompositeEvaluator;

  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.NOT, [true]), false);
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.NOT, [false]), true);
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.NOT, []), true);
});

test('CompositeEvaluator: evaluates NAND, NOR, and XOR boolean gates', () => {
  const evaluator = defaultCompositeEvaluator;

  // NAND: false only when all true
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.NAND, [true, true]), false);
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.NAND, [true, false]), true);

  // NOR: true only when all false
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.NOR, [false, false]), true);
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.NOR, [false, true]), false);

  // XOR: parity check (odd number of true inputs)
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.XOR, [true, false]), true);
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.XOR, [true, true]), false);
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.XOR, [false, false]), false);
  assert.equal(evaluator.evaluateOperator(LOGIC_OPERATORS.XOR, [true, true, true]), true);
});

test('CompositeEvaluator: rejects unsupported logical operators', () => {
  const evaluator = defaultCompositeEvaluator;

  assert.throws(
    () => evaluator.evaluateOperator('INVALID_OP', [true]),
    (err) => err instanceof CompositeEvaluatorError && err.code === 'UNSUPPORTED_LOGIC_OPERATOR'
  );
});

test('CompositeEvaluator: evaluateNode evaluates multi-condition states with window validation', () => {
  const evaluator = new CompositeEvaluator({ defaultWindowMs: 5000 });
  const node = {
    id: 'gate_and_1',
    config: { operator: 'AND', windowMs: 10000 },
  };

  const now = 1700000000000;

  // Both conditions valid and within 10s window
  const freshInputs = [
    { nodeId: 'cond_temp', valid: true, value: 92, timestamp: new Date(now - 2000).toISOString() },
    { nodeId: 'cond_vibe', valid: true, value: 14, timestamp: new Date(now - 1000).toISOString() },
  ];

  const result = evaluator.evaluateNode(node, freshInputs, { currentTimeMs: now });
  assert.equal(result.passed, true);
  assert.equal(result.satisfiedCount, 2);
  assert.equal(result.expiredCount, 0);

  // One condition is expired (stale telemetry from 15 seconds ago)
  const staleInputs = [
    { nodeId: 'cond_temp', valid: true, value: 92, timestamp: new Date(now - 15000).toISOString() }, // expired
    { nodeId: 'cond_vibe', valid: true, value: 14, timestamp: new Date(now - 1000).toISOString() },
  ];

  const staleResult = evaluator.evaluateNode(node, staleInputs, { currentTimeMs: now });
  assert.equal(staleResult.passed, false);
  assert.equal(staleResult.satisfiedCount, 1);
  assert.equal(staleResult.expiredCount, 1);
});

test('CompositeEvaluator: formatExpression outputs clean readable logic representations', () => {
  const evaluator = defaultCompositeEvaluator;

  assert.equal(evaluator.formatExpression('AND', ['Temp > 85', 'Vibe > 10']), '(Temp > 85 AND Vibe > 10)');
  assert.equal(evaluator.formatExpression('OR', ['Pressure > 150', 'LeakDetected']), '(Pressure > 150 OR LeakDetected)');
  assert.equal(evaluator.formatExpression('NOT', ['IsRunning']), 'NOT (IsRunning)');
});
