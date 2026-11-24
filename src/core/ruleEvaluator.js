'use strict';

const { defaultCompositeEvaluator } = require('./compositeEvaluator');
const { defaultDerivativeTransform } = require('./transforms/derivativeTransform');
const { defaultRuleReloader } = require('./ruleReloader');
const { defaultStateMachineEngine } = require('./stateMachine');

/**
 * NexusFlow Reactive In-Memory Rule Evaluator
 * Executes compiled AST pipelines against real-time incoming IoT telemetry streams.
 * Handles stateful transformations (moving average windows), multi-criteria condition
 * evaluation, composite logic gates (AND/OR), and rate-limited action dispatching.
 */

class RuleEvaluator {
  constructor(options = {}) {
    this.rules = new Map(); // ruleId -> { ast, state, metrics }
    this.alertHandler = options.onAlert || null; // optional callback for triggered alerts
  }

  /**
   * Registers/deploys a compiled AST rule into the live execution engine.
   * @param {Object} ast - Compiled rule AST from RuleParser.parse()
   */
  registerRule(ast) {
    if (!ast || !ast.ruleId || !ast.pipeline || !Array.isArray(ast.executionPlan)) {
      throw new Error('Invalid rule AST: Must contain ruleId, pipeline, and executionPlan');
    }

    const state = {
      transformBuffers: new Map(),  // nodeId -> Array of recent values
      derivativeBuffers: new Map(), // nodeId -> { previousValue, previousTimestamp, ... }
      actionCooldowns: new Map(),   // nodeId -> timestamp of last trigger
      conditionStates: new Map(),   // nodeId -> last evaluated result or { valid, value, timestamp }
      sensorCache: new Map(),       // "deviceId:sensorType" -> { value, timestamp }
      fsmStates: new Map(),         // "nodeId:deviceId" -> FSM state object
    };

    // Pre-initialize transform buffers
    for (const tf of ast.pipeline.transforms || []) {
      state.transformBuffers.set(tf.id, []);
    }

    const metrics = {
      ruleId: ast.ruleId,
      name: ast.name,
      evaluationsCount: 0,
      triggersCount: 0,
      lastEvaluatedAt: null,
      lastTriggeredAt: null,
      avgEvaluationTimeMs: 0,
      totalEvaluationTimeMs: 0,
      registeredAt: new Date().toISOString(),
    };

    this.rules.set(ast.ruleId, {
      ast,
      state,
      metrics,
    });

    return {
      ruleId: ast.ruleId,
      status: 'active',
      nodeCount: ast.metadata.nodeCount,
      executionPlan: ast.executionPlan,
    };
  }

  /**
   * Undeploys a rule from the active evaluation pool.
   * @param {string} ruleId
   * @returns {boolean} True if rule was found and removed
   */
  unregisterRule(ruleId) {
    return this.rules.delete(ruleId);
  }

  /**
   * Compares an incoming rule AST against the currently deployed rule.
   * @param {Object} newAst
   */
  diffRule(newAst) {
    if (!newAst || !newAst.ruleId) return null;
    const existing = this.rules.get(newAst.ruleId);
    if (!existing) return null;
    return defaultRuleReloader.diffRules(existing.ast, newAst);
  }

  /**
   * Atomically hot-reloads an active rule pipeline, preserving transform history and timers.
   * @param {Object} newAst - New compiled rule AST
   * @param {Object} [options]
   * @param {boolean} [options.preserveState=true]
   */
  hotReloadRule(newAst, options = {}) {
    if (!newAst || !newAst.ruleId || !newAst.pipeline || !Array.isArray(newAst.executionPlan)) {
      throw new Error('Invalid rule AST: Must contain ruleId, pipeline, and executionPlan');
    }

    const ruleId = String(newAst.ruleId);
    const existing = this.rules.get(ruleId);

    if (!existing) {
      // If not previously deployed, register normally
      const registration = this.registerRule(newAst);
      return {
        ruleId,
        status: 'deployed',
        isNew: true,
        diff: null,
        preservedBufferCount: 0,
        nodeCount: registration.nodeCount,
      };
    }

    const preserveState = options.preserveState !== false;
    const diff = defaultRuleReloader.diffRules(existing.ast, newAst);

    let state;
    let preservedBufferCount = 0;

    if (preserveState) {
      const migration = defaultRuleReloader.migrateState(existing.state, diff);
      state = migration.newState;
      preservedBufferCount = migration.preservedBufferCount;
    } else {
      // Clean slate state
      state = {
        transformBuffers: new Map(),
        derivativeBuffers: new Map(),
        actionCooldowns: new Map(),
        conditionStates: new Map(),
        sensorCache: new Map(),
        fsmStates: new Map(),
      };
    }

    // Retain existing performance metrics while updating timestamps
    const metrics = {
      ...existing.metrics,
      name: newAst.name || existing.metrics.name,
      lastReloadedAt: new Date().toISOString(),
      reloadsCount: (existing.metrics.reloadsCount || 0) + 1,
    };

    // Atomic in-memory swap
    this.rules.set(ruleId, {
      ast: newAst,
      state,
      metrics,
    });

    return {
      ruleId,
      status: 'reloaded',
      isNew: false,
      diff,
      preservedBufferCount,
      reloadsCount: metrics.reloadsCount,
    };
  }

  /**
   * Retrieves active rule details and runtime metrics.
   * @param {string} ruleId
   */
  getRule(ruleId) {
    const entry = this.rules.get(ruleId);
    if (!entry) return null;
    return {
      ast: entry.ast,
      metrics: { ...entry.metrics },
    };
  }

  /**
   * Returns a list of all currently deployed rules and their health metrics.
   */
  getActiveRules() {
    const active = [];
    for (const [id, entry] of this.rules.entries()) {
      active.push({
        ruleId: id,
        name: entry.ast.name,
        topology: entry.ast.metadata.topology,
        metrics: { ...entry.metrics },
      });
    }
    return active;
  }

  /**
   * Clears all registered rules and runtime states.
   */
  reset() {
    this.rules.clear();
  }

  /**
   * Evaluates an incoming IoT telemetry reading against all registered rules.
   * @param {Object} reading - { deviceId, sensorType, value, timestamp, unit }
   * @returns {Object} Evaluation report containing triggered alerts and timing diagnostics
   */
  evaluate(reading) {
    if (!reading || typeof reading.value === 'undefined') {
      return { matchedRules: 0, triggeredAlerts: [] };
    }

    const startTime = process.hrtime.bigint();
    const triggeredAlerts = [];
    let matchedRulesCount = 0;

    for (const entry of this.rules.values()) {
      const { ast, state, metrics } = entry;

      // 1. Check if this telemetry reading matches any source in the rule
      const matchingSources = ast.pipeline.sources.filter((src) => {
        const devMatch = src.config.deviceId === 'all' || src.config.deviceId === reading.deviceId;
        const typeMatch = !src.config.sensorType || src.config.sensorType === 'generic' || src.config.sensorType === reading.sensorType;
        return devMatch && typeMatch;
      });

      if (matchingSources.length === 0) {
        continue;
      }

      matchedRulesCount++;
      const ruleStartTime = process.hrtime.bigint();

      // 2. Map node outputs across the execution plan
      const nodeOutputs = new Map();

      // Seed matching source nodes with the reading value
      for (const src of matchingSources) {
        nodeOutputs.set(src.id, {
          value: Number(reading.value),
          valid: true,
          deviceId: reading.deviceId,
          sensorType: reading.sensorType,
          timestamp: reading.timestamp || new Date().toISOString(),
        });
      }

      // Build node lookup map for quick access
      const allNodes = new Map();
      [
        ...ast.pipeline.sources,
        ...ast.pipeline.transforms,
        ...ast.pipeline.conditions,
        ...(ast.pipeline.logics || []),
        ...(ast.pipeline.stateMachines || []),
        ...ast.pipeline.actions,
      ].forEach((n) => allNodes.set(n.id, n));

      // Build reverse adjacency for incoming inputs
      const nodeInputs = new Map();
      for (const id of allNodes.keys()) {
        nodeInputs.set(id, []);
      }
      for (const edge of (ast.edges || [])) {
        if (nodeInputs.has(edge.target)) {
          nodeInputs.get(edge.target).push(edge.source);
        }
      }

      // Fallback: if edges are not directly stored on AST root, reconstruct from execution plan
      const executionPlan = ast.executionPlan;

      // 3. Step through the execution plan
      for (const nodeId of executionPlan) {
        const node = allNodes.get(nodeId);
        if (!node) continue;

        if (node.category === 'source') {
          // Already seeded if matched
          continue;
        }

        // Determine incoming data from predecessors
        const incomingSources = nodeInputs.get(nodeId) || [];
        const incomingValues = [];
        let allPredecessorsPassed = true;

        for (const inputId of incomingSources) {
          const prevOut = nodeOutputs.get(inputId);
          if (prevOut) {
            if (prevOut.valid === false) {
              allPredecessorsPassed = false;
            }
            if (typeof prevOut.value === 'number') {
              incomingValues.push(prevOut.value);
            }
          }
        }

        // Check if any incoming input was active in this evaluation cycle
        const hasActiveInput = incomingSources.length === 0 || incomingSources.some((srcId) => nodeOutputs.has(srcId));

        if (!hasActiveInput && (node.category === 'condition' || node.category === 'transform')) {
          if (state.conditionStates.has(node.id)) {
            nodeOutputs.set(node.id, state.conditionStates.get(node.id));
          } else {
            nodeOutputs.set(node.id, { valid: false, value: undefined, timestamp: 0 });
          }
          continue;
        }

        // Default value: fallback to latest reading value if direct wire was implicit in linear chain
        const currentValue = incomingValues.length > 0 ? incomingValues[0] : Number(reading.value);

        if (node.category === 'transform') {
          const transformedValue = this._executeTransform(node, currentValue, reading.timestamp, state);
          nodeOutputs.set(node.id, {
            value: transformedValue,
            valid: true,
          });
        } else if (node.category === 'condition') {
          const conditionPassed = this._executeCondition(node, currentValue);
          state.conditionStates.set(node.id, {
            valid: conditionPassed,
            value: currentValue,
            timestamp: Date.now(),
          });
          nodeOutputs.set(node.id, {
            value: currentValue,
            valid: conditionPassed,
          });
        } else if (node.category === 'state_machine') {
          const fsmResult = defaultStateMachineEngine.evaluate(
            node.id,
            reading.deviceId,
            currentValue,
            node.config,
            state.fsmStates
          );
          state.conditionStates.set(node.id, {
            valid: fsmResult.isTriggered,
            value: currentValue,
            fsmState: fsmResult.currentState,
            timestamp: Date.now(),
          });
          nodeOutputs.set(node.id, {
            value: currentValue,
            valid: fsmResult.isTriggered,
            fsmResult,
          });
        } else if (node.category === 'logic') {
          // Gather predecessor states from current execution or prior cached states
          const incomingStates = [];
          for (const inputId of incomingSources) {
            if (nodeOutputs.has(inputId)) {
              const out = nodeOutputs.get(inputId);
              incomingStates.push({
                nodeId: inputId,
                valid: out.valid,
                value: out.value,
                timestamp: Date.now(),
              });
            } else if (state.conditionStates.has(inputId)) {
              const prev = state.conditionStates.get(inputId);
              incomingStates.push({
                nodeId: inputId,
                valid: typeof prev === 'boolean' ? prev : prev.valid,
                value: typeof prev === 'object' ? prev.value : undefined,
                timestamp: typeof prev === 'object' ? prev.timestamp : Date.now(),
              });
            } else {
              incomingStates.push({
                nodeId: inputId,
                valid: false,
                timestamp: 0,
              });
            }
          }

          const logicSummary = defaultCompositeEvaluator.evaluateNode(node, incomingStates);
          state.conditionStates.set(node.id, {
            valid: logicSummary.passed,
            value: logicSummary,
            timestamp: Date.now(),
          });
          nodeOutputs.set(node.id, {
            value: currentValue,
            valid: logicSummary.passed,
            logicSummary,
          });
        } else if (node.category === 'action') {
          // Check if condition leading to this action passed
          let conditionSatisfied = true;
          if (incomingSources.length > 0) {
            for (const inputId of incomingSources) {
              const prev = nodeOutputs.get(inputId);
              if (!prev || prev.valid !== true) {
                conditionSatisfied = false;
                break;
              }
            }
          } else {
            // Check overall condition states
            for (const condResult of state.conditionStates.values()) {
              const isOk = typeof condResult === 'boolean' ? condResult : condResult.valid;
              if (!isOk) {
                conditionSatisfied = false;
                break;
              }
            }
          }

          if (conditionSatisfied) {
            const alert = this._processActionTrigger(node, ast, reading, currentValue, state);
            if (alert) {
              triggeredAlerts.push(alert);
              metrics.triggersCount++;
              metrics.lastTriggeredAt = alert.timestamp;

              if (typeof this.alertHandler === 'function') {
                try {
                  this.alertHandler(alert);
                } catch (err) {
                  console.error(`[RuleEvaluator] Alert handler callback failed for rule ${ast.ruleId}:`, err.message);
                }
              }
            }
          }
        }
      }

      // Update rule metrics
      const ruleEndTime = process.hrtime.bigint();
      const ruleElapsedMs = Number(ruleEndTime - ruleStartTime) / 1e6;

      metrics.evaluationsCount++;
      metrics.lastEvaluatedAt = new Date().toISOString();
      metrics.totalEvaluationTimeMs += ruleElapsedMs;
      metrics.avgEvaluationTimeMs = Math.round((metrics.totalEvaluationTimeMs / metrics.evaluationsCount) * 1000) / 1000;
    }

    const totalEndTime = process.hrtime.bigint();
    const totalElapsedMs = Number(totalEndTime - startTime) / 1e6;

    return {
      evaluatedAt: new Date().toISOString(),
      matchedRules: matchedRulesCount,
      triggeredAlerts,
      totalExecutionTimeMs: Math.round(totalElapsedMs * 1000) / 1000,
    };
  }

  _executeTransform(node, value, timestamp, state) {
    const config = node.config || {};
    const operation = (config.operation || 'moving-average').toLowerCase();

    if (operation === 'rate-of-change' || operation === 'derivative') {
      return defaultDerivativeTransform.compute(node, value, timestamp, state);
    }

    if (operation === 'moving-average') {
      const windowSize = Math.max(1, config.windowSize || 5);
      let buffer = state.transformBuffers.get(node.id);
      if (!buffer) {
        buffer = [];
        state.transformBuffers.set(node.id, buffer);
      }
      buffer.push(value);
      if (buffer.length > windowSize) {
        buffer.shift();
      }
      const sum = buffer.reduce((acc, v) => acc + v, 0);
      return Math.round((sum / buffer.length) * 100) / 100;
    }

    if (operation === 'scale') {
      const factor = typeof config.factor === 'number' ? config.factor : 1;
      return Math.round((value * factor) * 100) / 100;
    }

    if (operation === 'offset') {
      const offset = typeof config.offset === 'number' ? config.offset : 0;
      return Math.round((value + offset) * 100) / 100;
    }

    return value;
  }

  _executeCondition(node, value) {
    const config = node.config || {};
    const operator = config.operator || '>';
    const threshold = typeof config.threshold === 'number' ? config.threshold : 0;
    const min = typeof config.min === 'number' ? config.min : 0;
    const max = typeof config.max === 'number' ? config.max : 100;

    switch (operator) {
      case '>':
        return value > threshold;
      case '<':
        return value < threshold;
      case '>=':
        return value >= threshold;
      case '<=':
        return value <= threshold;
      case '==':
        return value === threshold;
      case '!=':
        return value !== threshold;
      case 'between':
        return value >= min && value <= max;
      case 'outside':
        return value < min || value > max;
      default:
        return value > threshold;
    }
  }

  _processActionTrigger(node, ast, reading, evaluatedValue, state) {
    const config = node.config || {};
    const cooldownSeconds = typeof config.cooldownSeconds === 'number' ? config.cooldownSeconds : 60;
    const now = Date.now();
    const lastFired = state.actionCooldowns.get(node.id) || 0;

    // Enforce cooldown interval
    if (now - lastFired < cooldownSeconds * 1000) {
      return null; // Suppressed by cooldown policy
    }

    // Update cooldown timestamp
    state.actionCooldowns.set(node.id, now);

    // Format message template
    const template = config.template || 'Anomaly detected on sensor {deviceId}: current value {value} breached threshold {threshold}';
    const message = template
      .replace('{deviceId}', reading.deviceId || 'unknown')
      .replace('{sensorType}', reading.sensorType || 'sensor')
      .replace('{value}', String(evaluatedValue))
      .replace('{threshold}', String(config.threshold || 0))
      .replace('{unit}', reading.unit || '');

    return {
      alertId: `alert_${now}_${Math.random().toString(36).substring(2, 7)}`,
      ruleId: ast.ruleId,
      ruleName: ast.name,
      actionNodeId: node.id,
      actionType: config.actionType || 'alert',
      target: config.target || 'operators',
      priority: config.priority || 'medium',
      deviceId: reading.deviceId,
      sensorType: reading.sensorType,
      value: evaluatedValue,
      message,
      timestamp: new Date(now).toISOString(),
    };
  }
}

const defaultRuleEvaluator = new RuleEvaluator();

module.exports = {
  RuleEvaluator,
  defaultRuleEvaluator,
};
