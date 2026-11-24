'use strict';

/**
 * NexusFlow Finite State Machine (FSM) Engine
 * Eliminates alert flapping on noisy sensor boundaries by enforcing hysteresis
 * deadbands and multi-sample debounce transitions across four canonical states:
 *   IDLE -> WARNING -> CRITICAL -> RECOVERY -> IDLE
 */

const FSM_STATES = {
  IDLE: 'IDLE',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
  RECOVERY: 'RECOVERY',
};

const VALID_TRIGGER_STATES = new Set(Object.values(FSM_STATES));

class StateMachineEngine {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxHistoryPerKey=25] - Maximum state transition events retained per machine
   */
  constructor(options = {}) {
    this.states = new Map(); // "nodeId:entityKey" -> machine state object
    this.maxHistoryPerKey = options.maxHistoryPerKey || 25;
  }

  /**
   * Evaluates a numeric telemetry reading against a stateful FSM node.
   *
   * @param {string} nodeId - Visual node identifier
   * @param {string} entityKey - Device or stream partition key (e.g. "turbine-01")
   * @param {number} value - Numeric telemetry reading
   * @param {Object} [config] - FSM node configuration
   * @param {Map} [externalStore] - Optional per-rule Map for isolated rule persistence
   * @returns {Object} Transition evaluation result
   */
  evaluate(nodeId, entityKey, value, config = {}, externalStore = null) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`Invalid numeric telemetry value for FSM node "${nodeId}": ${value}`);
    }

    const store = externalStore instanceof Map ? externalStore : this.states;
    const machineKey = `${nodeId}:${entityKey || 'default'}`;
    const cfg = this._normalizeConfig(config);
    const now = Date.now();

    let machine = store.get(machineKey);
    if (!machine) {
      machine = {
        key: machineKey,
        nodeId,
        entityKey: entityKey || 'default',
        currentState: FSM_STATES.IDLE,
        consecutiveWarning: 0,
        consecutiveCritical: 0,
        consecutiveSafe: 0,
        lastValue: value,
        enteredStateAt: now,
        transitionHistory: [],
      };
      store.set(machineKey, machine);
    }

    const previousState = machine.currentState;
    const zone = this._classifyZone(value, cfg);
    const nextState = this._computeNextState(machine, zone, cfg);
    const transitioned = nextState !== previousState;

    if (transitioned) {
      machine.currentState = nextState;
      machine.enteredStateAt = now;
      machine.transitionHistory.unshift({
        from: previousState,
        to: nextState,
        value,
        zone,
        timestamp: new Date(now).toISOString(),
      });
      if (machine.transitionHistory.length > this.maxHistoryPerKey) {
        machine.transitionHistory.pop();
      }
    }

    machine.lastValue = value;
    machine.lastEvaluatedAt = now;

    const isTriggered = cfg.triggerStates.includes(machine.currentState);

    return {
      nodeId,
      entityKey: machine.entityKey,
      previousState,
      currentState: machine.currentState,
      transitioned,
      isTriggered,
      zone,
      value,
      consecutiveWarning: machine.consecutiveWarning,
      consecutiveCritical: machine.consecutiveCritical,
      consecutiveSafe: machine.consecutiveSafe,
      historyCount: machine.transitionHistory.length,
      timestamp: new Date(now).toISOString(),
    };
  }

  /**
   * Normalizes FSM thresholds, hysteresis deadband, and debounce parameters.
   * @private
   */
  _normalizeConfig(config = {}) {
    const comparator = config.comparator === 'lt' ? 'lt' : 'gt';
    const warningThreshold = typeof config.warningThreshold === 'number' ? config.warningThreshold : 70;
    const criticalThreshold = typeof config.criticalThreshold === 'number' ? config.criticalThreshold : 90;
    const hysteresis = typeof config.hysteresis === 'number' ? Math.max(0, config.hysteresis) : 5;

    // Default recovery boundary sits outside warningThreshold by hysteresis distance
    const defaultRecovery = comparator === 'gt'
      ? warningThreshold - hysteresis
      : warningThreshold + hysteresis;
    const recoveryThreshold = typeof config.recoveryThreshold === 'number'
      ? config.recoveryThreshold
      : defaultRecovery;

    const triggerStates = Array.isArray(config.triggerStates) && config.triggerStates.length > 0
      ? config.triggerStates.map((s) => String(s).toUpperCase()).filter((s) => VALID_TRIGGER_STATES.has(s))
      : [FSM_STATES.CRITICAL];

    return {
      comparator,
      warningThreshold,
      criticalThreshold,
      recoveryThreshold,
      warningDebounceCount: Math.max(1, config.warningDebounceCount || 1),
      criticalDebounceCount: Math.max(1, config.criticalDebounceCount || 2),
      recoverySamplesCount: Math.max(1, config.recoverySamplesCount || 2),
      triggerStates: triggerStates.length > 0 ? triggerStates : [FSM_STATES.CRITICAL],
    };
  }

  /**
   * Maps reading into one of four zones: CRITICAL, WARNING, DEADBAND, SAFE.
   * Supports both upper-bound ('gt') and lower-bound ('lt') monitoring uniformly.
   * @private
   */
  _classifyZone(value, cfg) {
    if (cfg.comparator === 'lt') {
      if (value <= cfg.criticalThreshold) return 'CRITICAL';
      if (value <= cfg.warningThreshold) return 'WARNING';
      if (value <= cfg.recoveryThreshold) return 'DEADBAND';
      return 'SAFE';
    }

    if (value >= cfg.criticalThreshold) return 'CRITICAL';
    if (value >= cfg.warningThreshold) return 'WARNING';
    if (value >= cfg.recoveryThreshold) return 'DEADBAND';
    return 'SAFE';
  }

  /**
   * Applies debounced transitions and hysteresis anti-flapping rules.
   * @private
   */
  _computeNextState(machine, zone, cfg) {
    const state = machine.currentState;

    if (zone === 'CRITICAL') {
      machine.consecutiveSafe = 0;
      machine.consecutiveCritical += 1;
      machine.consecutiveWarning += 1;

      if (state === FSM_STATES.CRITICAL) return FSM_STATES.CRITICAL;
      if (machine.consecutiveCritical >= cfg.criticalDebounceCount) {
        return FSM_STATES.CRITICAL;
      }
      if (state === FSM_STATES.IDLE && machine.consecutiveWarning >= cfg.warningDebounceCount) {
        return FSM_STATES.WARNING;
      }
      if (state === FSM_STATES.RECOVERY && machine.consecutiveWarning >= cfg.warningDebounceCount) {
        return FSM_STATES.WARNING;
      }
      return state;
    }

    if (zone === 'WARNING') {
      machine.consecutiveSafe = 0;
      machine.consecutiveCritical = 0;
      machine.consecutiveWarning += 1;

      // Stay in CRITICAL while still above recovery deadband (prevents alert flapping)
      if (state === FSM_STATES.CRITICAL) return FSM_STATES.CRITICAL;

      if ((state === FSM_STATES.IDLE || state === FSM_STATES.RECOVERY) &&
          machine.consecutiveWarning >= cfg.warningDebounceCount) {
        return FSM_STATES.WARNING;
      }
      return state;
    }

    if (zone === 'DEADBAND') {
      // Hysteresis buffer: hold current alert state without escalating or recovering
      machine.consecutiveCritical = 0;
      machine.consecutiveWarning = 0;
      return state;
    }

    // zone === 'SAFE'
    machine.consecutiveCritical = 0;
    machine.consecutiveWarning = 0;
    machine.consecutiveSafe += 1;

    if (state === FSM_STATES.IDLE) {
      return FSM_STATES.IDLE;
    }

    if (machine.consecutiveSafe >= cfg.recoverySamplesCount) {
      machine.consecutiveSafe = 0;
      return FSM_STATES.IDLE;
    }

    if (state === FSM_STATES.CRITICAL || state === FSM_STATES.WARNING) {
      return FSM_STATES.RECOVERY;
    }

    return FSM_STATES.RECOVERY;
  }

  /**
   * Retrieves current machine state snapshot for diagnostics.
   */
  getMachineState(nodeId, entityKey = 'default', externalStore = null) {
    const store = externalStore instanceof Map ? externalStore : this.states;
    const entry = store.get(`${nodeId}:${entityKey}`);
    return entry ? { ...entry, transitionHistory: [...entry.transitionHistory] } : null;
  }

  /**
   * Resets state for a specific machine key or clears all tracked machines.
   */
  reset(nodeId = null, entityKey = null, externalStore = null) {
    const store = externalStore instanceof Map ? externalStore : this.states;
    if (nodeId && entityKey) {
      store.delete(`${nodeId}:${entityKey}`);
    } else if (nodeId) {
      const prefix = `${nodeId}:`;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) store.delete(key);
      }
    } else {
      store.clear();
    }
  }
}

const defaultStateMachineEngine = new StateMachineEngine();

module.exports = {
  FSM_STATES,
  StateMachineEngine,
  defaultStateMachineEngine,
};
