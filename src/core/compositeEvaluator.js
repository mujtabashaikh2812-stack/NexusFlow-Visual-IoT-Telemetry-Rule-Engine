'use strict';

/**
 * NexusFlow Composite Condition Logic Evaluator
 * Evaluates multi-criteria boolean logic gates (AND, OR, NOT, NAND, NOR, XOR)
 * across branching canvas topologies and asynchronous multi-sensor streams.
 */

const LOGIC_OPERATORS = {
  AND: 'AND',
  OR: 'OR',
  NOT: 'NOT',
  NAND: 'NAND',
  NOR: 'NOR',
  XOR: 'XOR',
};

class CompositeEvaluatorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CompositeEvaluatorError';
    this.code = code;
    this.details = details;
  }
}

class CompositeEvaluator {
  constructor(options = {}) {
    this.defaultWindowMs = options.defaultWindowMs || 30000; // 30s default sliding time-window
  }

  /**
   * Evaluates a logical operator across an array of boolean inputs.
   * @param {string} operator - 'AND' | 'OR' | 'NOT' | 'NAND' | 'NOR' | 'XOR'
   * @param {Array<boolean>} booleanInputs - List of truthy/falsy evaluation values
   * @returns {boolean} Combined boolean result
   */
  evaluateOperator(operator = LOGIC_OPERATORS.AND, booleanInputs = []) {
    const op = String(operator).toUpperCase();

    if (!Array.isArray(booleanInputs) || booleanInputs.length === 0) {
      if (op === LOGIC_OPERATORS.NOT) return true;
      return false;
    }

    switch (op) {
      case LOGIC_OPERATORS.AND:
        // True only if every input evaluates to true
        return booleanInputs.every((v) => Boolean(v) === true);

      case LOGIC_OPERATORS.OR:
        // True if at least one input evaluates to true
        return booleanInputs.some((v) => Boolean(v) === true);

      case LOGIC_OPERATORS.NOT:
        // Inverts the first input (or true if empty)
        return !Boolean(booleanInputs[0]);

      case LOGIC_OPERATORS.NAND:
        // Inversion of AND
        return !booleanInputs.every((v) => Boolean(v) === true);

      case LOGIC_OPERATORS.NOR:
        // Inversion of OR
        return !booleanInputs.some((v) => Boolean(v) === true);

      case LOGIC_OPERATORS.XOR:
        // True if an odd number of inputs are true (parity check)
        const trueCount = booleanInputs.filter((v) => Boolean(v) === true).length;
        return trueCount % 2 === 1;

      default:
        throw new CompositeEvaluatorError(
          'UNSUPPORTED_LOGIC_OPERATOR',
          `Unknown logical operator: "${operator}". Supported operators: ${Object.values(LOGIC_OPERATORS).join(', ')}`
        );
    }
  }

  /**
   * Evaluates a composite logic node against incoming predecessor states.
   * Considers time-window staleness for asynchronous multi-sensor streams.
   * @param {Object} logicNode - Normalized logic/composite AST node
   * @param {Array<Object>} incomingStates - List of { nodeId, valid, value, timestamp }
   * @param {Object} [options]
   * @param {number} [options.currentTimeMs] - Override current timestamp for deterministic testing
   * @returns {Object} Evaluation summary
   */
  evaluateNode(logicNode, incomingStates = [], options = {}) {
    if (!logicNode || typeof logicNode !== 'object') {
      throw new CompositeEvaluatorError('INVALID_NODE', 'Logic node must be a valid object');
    }

    const config = logicNode.config || {};
    const operator = (config.operator || config.logicOperator || LOGIC_OPERATORS.AND).toUpperCase();
    const windowMs = typeof config.windowMs === 'number' ? config.windowMs : this.defaultWindowMs;
    const now = options.currentTimeMs || Date.now();

    const evaluatedInputs = [];
    const booleanValues = [];

    for (const state of incomingStates) {
      if (!state) continue;

      const stateTimestamp = state.timestamp ? new Date(state.timestamp).getTime() : now;
      const isExpired = windowMs > 0 && (now - stateTimestamp > windowMs);
      const isSatisfied = !isExpired && Boolean(state.valid);

      evaluatedInputs.push({
        nodeId: state.nodeId || 'unknown',
        value: state.value,
        valid: Boolean(state.valid),
        isExpired,
        isSatisfied,
        ageMs: Math.max(0, now - stateTimestamp),
      });

      booleanValues.push(isSatisfied);
    }

    const passed = this.evaluateOperator(operator, booleanValues);
    const satisfiedCount = evaluatedInputs.filter((i) => i.isSatisfied).length;
    const expiredCount = evaluatedInputs.filter((i) => i.isExpired).length;

    return {
      nodeId: logicNode.id,
      operator,
      passed,
      satisfiedCount,
      expiredCount,
      totalInputs: evaluatedInputs.length,
      evaluatedInputs,
      evaluatedAt: new Date(now).toISOString(),
    };
  }

  /**
   * Helper to build a composite condition expression string for logs & visualization.
   * @param {string} operator
   * @param {Array<string>} nodeLabels
   */
  formatExpression(operator, nodeLabels = []) {
    const op = String(operator || 'AND').toUpperCase();
    if (op === LOGIC_OPERATORS.NOT) {
      return `NOT (${nodeLabels[0] || 'input'})`;
    }
    return `(${nodeLabels.join(` ${op} `)})`;
  }
}

const defaultCompositeEvaluator = new CompositeEvaluator();

module.exports = {
  CompositeEvaluator,
  CompositeEvaluatorError,
  LOGIC_OPERATORS,
  defaultCompositeEvaluator,
};
