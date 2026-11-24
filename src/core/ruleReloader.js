'use strict';

/**
 * NexusFlow Dynamic Rule Hot-Reloader & Semantic Diff Engine
 * Performs atomic in-memory rule updates, computes AST differentials,
 * and seamlessly preserves historical transform buffers and cooldowns.
 */

class RuleReloader {
  /**
   * Computes a semantic diff between an existing deployed rule AST and an incoming replacement.
   * @param {Object} oldAst
   * @param {Object} newAst
   * @returns {Object} Semantic diff breakdown
   */
  diffRules(oldAst, newAst) {
    if (!oldAst || !newAst) {
      throw new Error('Both oldAst and newAst must be provided for diff comparison');
    }

    const oldNodes = this._extractNodeMap(oldAst);
    const newNodes = this._extractNodeMap(newAst);

    const added = [];
    const removed = [];
    const modified = [];
    const retained = [];

    // Check additions and modifications
    for (const [id, newNode] of newNodes.entries()) {
      if (!oldNodes.has(id)) {
        added.push({ id, category: newNode.category, type: newNode.type });
      } else {
        const oldNode = oldNodes.get(id);
        const configDiff = this._diffConfig(oldNode.config, newNode.config);
        if (configDiff.changed || oldNode.category !== newNode.category) {
          modified.push({
            id,
            category: newNode.category,
            changes: configDiff.changes,
          });
        } else {
          retained.push({ id, category: newNode.category });
        }
      }
    }

    // Check removals
    for (const [id, oldNode] of oldNodes.entries()) {
      if (!newNodes.has(id)) {
        removed.push({ id, category: oldNode.category, type: oldNode.type });
      }
    }

    // Check topology differences
    const oldEdges = (oldAst.edges || []).map((e) => `${e.source}->${e.target}`).sort().join(';');
    const newEdges = (newAst.edges || []).map((e) => `${e.source}->${e.target}`).sort().join(';');
    const topologyChanged = oldEdges !== newEdges;

    const hasChanges = added.length > 0 || removed.length > 0 || modified.length > 0 || topologyChanged;

    return {
      ruleId: newAst.ruleId,
      hasChanges,
      topologyChanged,
      nodes: {
        added,
        removed,
        modified,
        retained,
      },
      summary: `Nodes: +${added.length} -${removed.length} ~${modified.length} =${retained.length}${topologyChanged ? ' [Topology Modified]' : ''}`,
    };
  }

  /**
   * Migrates state buffers from an existing rule execution context to the updated rule.
   * Preserves moving average windows, derivative gradient baselines, and action cooldowns.
   * @param {Object} oldState - Existing engine state for the rule
   * @param {Object} diff - Diff result from diffRules()
   * @returns {Object} Migrated state container and migration statistics
   */
  migrateState(oldState, diff) {
    const newState = {
      transformBuffers: new Map(),
      derivativeBuffers: new Map(),
      actionCooldowns: new Map(),
      conditionStates: new Map(),
      sensorCache: new Map(),
      fsmStates: new Map(),
    };

    if (!oldState) {
      return { newState, preservedBufferCount: 0 };
    }

    let preservedBufferCount = 0;

    // Preserved node IDs: both retained and modified (if category is consistent)
    const validIds = new Set([
      ...diff.nodes.retained.map((n) => n.id),
      ...diff.nodes.modified.map((n) => n.id),
    ]);

    // 1. Migrate transform rolling buffers
    if (oldState.transformBuffers) {
      for (const [nodeId, buffer] of oldState.transformBuffers.entries()) {
        if (validIds.has(nodeId) && Array.isArray(buffer)) {
          newState.transformBuffers.set(nodeId, [...buffer]);
          preservedBufferCount++;
        }
      }
    }

    // 2. Migrate derivative calculation buffers
    if (oldState.derivativeBuffers) {
      for (const [nodeId, devState] of oldState.derivativeBuffers.entries()) {
        if (validIds.has(nodeId) && devState) {
          newState.derivativeBuffers.set(nodeId, { ...devState });
          preservedBufferCount++;
        }
      }
    }

    // 3. Migrate action cooldown timestamps
    if (oldState.actionCooldowns) {
      for (const [nodeId, timestamp] of oldState.actionCooldowns.entries()) {
        if (validIds.has(nodeId)) {
          newState.actionCooldowns.set(nodeId, timestamp);
          preservedBufferCount++;
        }
      }
    }

    // 4. Carry forward sensor reading cache
    if (oldState.sensorCache) {
      for (const [key, sensorData] of oldState.sensorCache.entries()) {
        newState.sensorCache.set(key, { ...sensorData });
      }
    }

    // 5. Carry forward condition states
    if (oldState.conditionStates) {
      for (const [nodeId, condData] of oldState.conditionStates.entries()) {
        if (validIds.has(nodeId)) {
          newState.conditionStates.set(nodeId, typeof condData === 'object' ? { ...condData } : condData);
        }
      }
    }

    // 6. Migrate FSM state machines keyed by "nodeId:entityKey"
    if (oldState.fsmStates) {
      for (const [machineKey, fsmEntry] of oldState.fsmStates.entries()) {
        if (fsmEntry && validIds.has(fsmEntry.nodeId)) {
          newState.fsmStates.set(machineKey, {
            ...fsmEntry,
            transitionHistory: [...(fsmEntry.transitionHistory || [])],
          });
          preservedBufferCount++;
        }
      }
    }

    return {
      newState,
      preservedBufferCount,
    };
  }

  _extractNodeMap(ast) {
    const map = new Map();
    const pipeline = ast.pipeline || {};
    const all = [
      ...(pipeline.sources || []),
      ...(pipeline.transforms || []),
      ...(pipeline.conditions || []),
      ...(pipeline.logics || []),
      ...(pipeline.stateMachines || []),
      ...(pipeline.actions || []),
    ];
    for (const node of all) {
      map.set(node.id, node);
    }
    return map;
  }

  _diffConfig(c1 = {}, c2 = {}) {
    const changes = {};
    let changed = false;

    const keys = new Set([...Object.keys(c1), ...Object.keys(c2)]);
    for (const key of keys) {
      if (c1[key] !== c2[key]) {
        changes[key] = { from: c1[key], to: c2[key] };
        changed = true;
      }
    }

    return { changed, changes };
  }
}

const defaultRuleReloader = new RuleReloader();

module.exports = {
  RuleReloader,
  defaultRuleReloader,
};
