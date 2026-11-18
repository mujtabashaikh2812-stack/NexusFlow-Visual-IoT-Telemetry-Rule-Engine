'use strict';

/**
 * NexusFlow Rate-of-Change & Derivative Telemetry Transform
 * Calculates mathematical gradients (dV/dt) across continuous time-series
 * streams to detect thermal runaway, sudden pressure surges, and vibration anomalies
 * prior to absolute threshold breaches.
 */

const DERIVATIVE_MODES = {
  INSTANT: 'instant',
  SMOOTHED: 'smoothed',
  PERCENTAGE: 'percentage',
  ABSOLUTE: 'absolute',
};

const TIME_UNITS = {
  PER_SECOND: 'per_second',
  PER_MINUTE: 'per_minute',
  PER_HOUR: 'per_hour',
};

class DerivativeTransformError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DerivativeTransformError';
    this.code = code;
    this.details = details;
  }
}

class DerivativeTransform {
  constructor(options = {}) {
    this.defaultMinDeltaMs = options.minDeltaMs || 50;
    this.defaultAlpha = options.smoothingAlpha || 0.3;
  }

  /**
   * Computes the rate-of-change (derivative) of a sensor stream.
   * @param {Object} node - Transform AST node configuration
   * @param {number} currentValue - Current telemetry reading value
   * @param {number|string|Date} currentTimestamp - Timestamp of the current reading
   * @param {Object} state - Engine state maintaining node history buffers
   * @returns {number} Calculated rate of change
   */
  compute(node, currentValue, currentTimestamp, state) {
    if (typeof currentValue !== 'number' || isNaN(currentValue)) {
      return 0;
    }

    const config = node.config || {};
    const mode = (config.mode || DERIVATIVE_MODES.INSTANT).toLowerCase();
    const timeUnit = (config.timeUnit || TIME_UNITS.PER_SECOND).toLowerCase();
    const minDeltaMs = typeof config.minDeltaTimeMs === 'number' ? config.minDeltaTimeMs : this.defaultMinDeltaMs;
    const alpha = typeof config.smoothingAlpha === 'number' ? config.smoothingAlpha : this.defaultAlpha;
    const direction = (config.direction || 'any').toLowerCase();

    // Parse timestamp to epoch ms
    const currentMs = currentTimestamp ? new Date(currentTimestamp).getTime() : Date.now();

    // Initialize or fetch node derivative state
    if (!state.derivativeBuffers) {
      state.derivativeBuffers = new Map();
    }

    let nodeState = state.derivativeBuffers.get(node.id);
    if (!nodeState) {
      nodeState = {
        previousValue: currentValue,
        previousTimestamp: currentMs,
        previousGradient: 0,
        smoothedGradient: 0,
        sampleCount: 1,
      };
      state.derivativeBuffers.set(node.id, nodeState);
      return 0; // Baseline initialized, gradient is 0 on first sample
    }

    const deltaMs = currentMs - nodeState.previousTimestamp;

    // Prevent divide-by-zero or excessive noise from sub-threshold microsecond bursts
    if (deltaMs < minDeltaMs) {
      return nodeState.previousGradient;
    }

    const deltaValue = currentValue - nodeState.previousValue;

    // Time scaling multiplier
    let timeScale = 1000; // per second
    if (timeUnit === TIME_UNITS.PER_MINUTE) {
      timeScale = 60000;
    } else if (timeUnit === TIME_UNITS.PER_HOUR) {
      timeScale = 3600000;
    }

    let gradient = 0;

    if (mode === DERIVATIVE_MODES.PERCENTAGE) {
      if (nodeState.previousValue !== 0) {
        gradient = (deltaValue / Math.abs(nodeState.previousValue)) * 100 * (timeScale / deltaMs);
      } else {
        gradient = (deltaValue / 1) * (timeScale / deltaMs);
      }
    } else {
      gradient = (deltaValue / deltaMs) * timeScale;
    }

    if (mode === DERIVATIVE_MODES.ABSOLUTE) {
      gradient = Math.abs(gradient);
    } else if (mode === DERIVATIVE_MODES.SMOOTHED) {
      // Exponential Moving Average (EMA) smoothing
      if (nodeState.sampleCount === 1) {
        nodeState.smoothedGradient = gradient;
      } else {
        nodeState.smoothedGradient = (alpha * gradient) + ((1 - alpha) * nodeState.smoothedGradient);
      }
      gradient = nodeState.smoothedGradient;
    }

    // Directional filtering
    if (direction === 'increasing' && gradient < 0) {
      gradient = 0;
    } else if (direction === 'decreasing' && gradient > 0) {
      gradient = 0;
    }

    // Round to 3 decimal places for stability
    const rounded = Math.round(gradient * 1000) / 1000;

    // Update state history
    nodeState.previousValue = currentValue;
    nodeState.previousTimestamp = currentMs;
    nodeState.previousGradient = rounded;
    nodeState.sampleCount++;

    return rounded;
  }

  /**
   * Resets internal history for a specific transform node.
   * @param {string} nodeId
   * @param {Object} state
   */
  resetNode(nodeId, state) {
    if (state.derivativeBuffers && state.derivativeBuffers.has(nodeId)) {
      state.derivativeBuffers.delete(nodeId);
    }
  }
}

const defaultDerivativeTransform = new DerivativeTransform();

module.exports = {
  DerivativeTransform,
  DerivativeTransformError,
  DERIVATIVE_MODES,
  TIME_UNITS,
  defaultDerivativeTransform,
};
