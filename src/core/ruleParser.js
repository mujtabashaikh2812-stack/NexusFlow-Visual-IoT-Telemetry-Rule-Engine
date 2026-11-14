'use strict';

/**
 * NexusFlow AST Rule Parser & Visual Graph Validator
 * Converts raw React Flow graph payloads (nodes & edges) into validated
 * Abstract Syntax Trees (AST) and executable pipeline plans.
 */

const NODE_CATEGORIES = {
  SOURCE: 'source',
  TRANSFORM: 'transform',
  CONDITION: 'condition',
  ACTION: 'action',
};

const VALID_OPERATORS = ['>', '<', '>=', '<=', '==', '!=', 'between', 'outside'];

class RuleParserError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuleParserError';
    this.code = code;
    this.details = details;
  }
}

class RuleParser {
  constructor(options = {}) {
    this.allowCycles = options.allowCycles || false;
    this.maxNodes = options.maxNodes || 100;
  }

  /**
   * Parses and validates a visual graph into an executable AST representation.
   * @param {Object} graphPayload - Object containing { id, name, nodes, edges }
   * @returns {Object} Validated AST Execution Plan
   */
  parse(graphPayload = {}) {
    if (!graphPayload || typeof graphPayload !== 'object') {
      throw new RuleParserError('INVALID_PAYLOAD', 'Graph payload must be a non-null object');
    }

    const ruleId = graphPayload.id || `rule_${Date.now()}`;
    const name = graphPayload.name || 'Untitled Rule Pipeline';
    const description = graphPayload.description || '';
    const nodes = Array.isArray(graphPayload.nodes) ? graphPayload.nodes : [];
    const edges = Array.isArray(graphPayload.edges) ? graphPayload.edges : [];

    // 1. Basic structural checks
    if (nodes.length === 0) {
      throw new RuleParserError('EMPTY_GRAPH', 'Rule graph must contain at least one source and one action node');
    }
    if (nodes.length > this.maxNodes) {
      throw new RuleParserError('EXCEEDS_MAX_NODES', `Graph exceeds maximum allowed nodes (${this.maxNodes})`);
    }

    // 2. Index nodes by ID
    const nodeMap = new Map();
    const sources = [];
    const transforms = [];
    const conditions = [];
    const actions = [];

    for (const node of nodes) {
      if (!node.id || typeof node.id !== 'string') {
        throw new RuleParserError('INVALID_NODE_ID', 'Every node must have a unique string id');
      }
      if (nodeMap.has(node.id)) {
        throw new RuleParserError('DUPLICATE_NODE_ID', `Duplicate node id detected: "${node.id}"`);
      }

      const category = this._categorizeNode(node);
      const normalizedNode = this._normalizeNode(node, category);
      nodeMap.set(node.id, normalizedNode);

      if (category === NODE_CATEGORIES.SOURCE) sources.push(normalizedNode);
      else if (category === NODE_CATEGORIES.TRANSFORM) transforms.push(normalizedNode);
      else if (category === NODE_CATEGORIES.CONDITION) conditions.push(normalizedNode);
      else if (category === NODE_CATEGORIES.ACTION) actions.push(normalizedNode);
    }

    if (sources.length === 0) {
      throw new RuleParserError('MISSING_SOURCE_NODE', 'Pipeline requires at least one data source node');
    }
    if (actions.length === 0) {
      throw new RuleParserError('MISSING_ACTION_NODE', 'Pipeline requires at least one action trigger node');
    }

    // 3. Build adjacency lists & degree maps
    const adjList = new Map(); // from -> [to]
    const reverseAdjList = new Map(); // to -> [from]
    const inDegree = new Map();

    for (const nodeId of nodeMap.keys()) {
      adjList.set(nodeId, []);
      reverseAdjList.set(nodeId, []);
      inDegree.set(nodeId, 0);
    }

    for (const edge of edges) {
      if (!edge.source || !edge.target) {
        throw new RuleParserError('INVALID_EDGE', 'Edges must have defined source and target identifiers', { edge });
      }
      if (!nodeMap.has(edge.source)) {
        throw new RuleParserError('ORPHANED_EDGE_SOURCE', `Edge references unknown source node: "${edge.source}"`);
      }
      if (!nodeMap.has(edge.target)) {
        throw new RuleParserError('ORPHANED_EDGE_TARGET', `Edge references unknown target node: "${edge.target}"`);
      }

      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);

      this._validateEdgeCategoryRules(sourceNode, targetNode);

      adjList.get(edge.source).push(edge.target);
      reverseAdjList.get(edge.target).push(edge.source);
      inDegree.set(edge.target, inDegree.get(edge.target) + 1);
    }

    // 4. Validate graph connectivity (Check for dangling/orphaned nodes)
    this._validateReachability(nodeMap, sources, actions, adjList, reverseAdjList);

    // 5. Detect cycles (Ensure Directed Acyclic Graph)
    if (!this.allowCycles) {
      this._detectCycles(nodeMap, adjList);
    }

    // 6. Compute topological execution order (Kahn's Algorithm)
    const executionPlan = this._computeExecutionPlan(nodeMap, inDegree, adjList);

    // 7. Compile structured AST output
    return {
      ruleId,
      name,
      description,
      version: '1.0.0',
      compiledAt: new Date().toISOString(),
      metadata: {
        nodeCount: nodeMap.size,
        edgeCount: edges.length,
        sourceCount: sources.length,
        actionCount: actions.length,
        isCyclic: false,
        topology: sources.length === 1 && actions.length === 1 ? 'linear' : 'multi-branch',
      },
      pipeline: {
        sources,
        transforms,
        conditions,
        actions,
      },
      executionPlan,
      isValid: true,
    };
  }

  _categorizeNode(node) {
    const type = String(node.type || '').toLowerCase();
    const dataCategory = node.data && node.data.category ? String(node.data.category).toLowerCase() : null;

    if (dataCategory && Object.values(NODE_CATEGORIES).includes(dataCategory)) {
      return dataCategory;
    }

    if (type.includes('source') || type.includes('sensor') || type.includes('mqtt') || type.includes('input')) {
      return NODE_CATEGORIES.SOURCE;
    }
    if (type.includes('transform') || type.includes('math') || type.includes('average') || type.includes('scale')) {
      return NODE_CATEGORIES.TRANSFORM;
    }
    if (type.includes('condition') || type.includes('threshold') || type.includes('compare') || type.includes('filter')) {
      return NODE_CATEGORIES.CONDITION;
    }
    if (type.includes('action') || type.includes('alert') || type.includes('sms') || type.includes('webhook') || type.includes('output')) {
      return NODE_CATEGORIES.ACTION;
    }

    return NODE_CATEGORIES.TRANSFORM;
  }

  _normalizeNode(node, category) {
    const data = node.data || {};
    const normalized = {
      id: node.id,
      category,
      type: node.type || category,
      label: data.label || node.id,
      config: {},
    };

    if (category === NODE_CATEGORIES.SOURCE) {
      normalized.config = {
        deviceId: data.deviceId || 'all',
        sensorType: data.sensorType || 'generic',
        sampleRateMs: data.sampleRateMs || 1000,
      };
    } else if (category === NODE_CATEGORIES.CONDITION) {
      const operator = data.operator && VALID_OPERATORS.includes(data.operator) ? data.operator : '>';
      normalized.config = {
        operator,
        threshold: typeof data.threshold === 'number' ? data.threshold : 0,
        min: typeof data.min === 'number' ? data.min : 0,
        max: typeof data.max === 'number' ? data.max : 100,
        durationSeconds: typeof data.durationSeconds === 'number' ? data.durationSeconds : 0,
      };
    } else if (category === NODE_CATEGORIES.TRANSFORM) {
      normalized.config = {
        operation: data.operation || 'moving-average',
        windowSize: data.windowSize || 5,
        factor: typeof data.factor === 'number' ? data.factor : 1,
      };
    } else if (category === NODE_CATEGORIES.ACTION) {
      normalized.config = {
        actionType: data.actionType || 'alert',
        target: data.target || 'operators',
        priority: data.priority || 'medium',
        template: data.template || 'Anomaly detected on sensor {deviceId}',
        cooldownSeconds: data.cooldownSeconds || 60,
      };
    }

    return normalized;
  }

  _validateEdgeCategoryRules(sourceNode, targetNode) {
    // 1. Action nodes cannot produce output to other nodes
    if (sourceNode.category === NODE_CATEGORIES.ACTION) {
      throw new RuleParserError(
        'INVALID_CONNECTION',
        `Action node "${sourceNode.id}" is a terminal sink and cannot output to node "${targetNode.id}"`
      );
    }

    // 2. Source nodes cannot accept inputs
    if (targetNode.category === NODE_CATEGORIES.SOURCE) {
      throw new RuleParserError(
        'INVALID_CONNECTION',
        `Source node "${targetNode.id}" is an entry point and cannot accept input from node "${sourceNode.id}"`
      );
    }
  }

  _validateReachability(nodeMap, sources, actions, adjList, reverseAdjList) {
    // Check if every node is reachable from at least one source (Forward DFS)
    const reachableFromSource = new Set();
    const forwardVisit = (nodeId) => {
      if (reachableFromSource.has(nodeId)) return;
      reachableFromSource.add(nodeId);
      for (const neighbor of adjList.get(nodeId)) {
        forwardVisit(neighbor);
      }
    };
    sources.forEach((s) => forwardVisit(s.id));

    // Check if every node can reach at least one action (Backward DFS)
    const canReachAction = new Set();
    const backwardVisit = (nodeId) => {
      if (canReachAction.has(nodeId)) return;
      canReachAction.add(nodeId);
      for (const parent of reverseAdjList.get(nodeId)) {
        backwardVisit(parent);
      }
    };
    actions.forEach((a) => backwardVisit(a.id));

    for (const nodeId of nodeMap.keys()) {
      if (!reachableFromSource.has(nodeId)) {
        throw new RuleParserError(
          'DANGLING_NODE',
          `Node "${nodeId}" cannot be reached from any source data node`
        );
      }
      if (!canReachAction.has(nodeId)) {
        throw new RuleParserError(
          'DANGLING_NODE',
          `Node "${nodeId}" has no forward path to an action trigger node`
        );
      }
    }
  }

  _detectCycles(nodeMap, adjList) {
    const visited = new Set();
    const inStack = new Set();

    const dfs = (nodeId, path = []) => {
      visited.add(nodeId);
      inStack.add(nodeId);
      path.push(nodeId);

      for (const neighbor of adjList.get(nodeId)) {
        if (!visited.has(neighbor)) {
          dfs(neighbor, [...path]);
        } else if (inStack.has(neighbor)) {
          const cyclePath = [...path, neighbor].join(' -> ');
          throw new RuleParserError('CYCLE_DETECTED', `Cycle detected in rule graph: ${cyclePath}`);
        }
      }

      inStack.delete(nodeId);
    };

    for (const nodeId of nodeMap.keys()) {
      if (!visited.has(nodeId)) {
        dfs(nodeId);
      }
    }
  }

  _computeExecutionPlan(nodeMap, inDegree, adjList) {
    const queue = [];
    const executionPlan = [];
    const inDegreeCopy = new Map(inDegree);

    // Collect all nodes with 0 incoming edges (source nodes)
    for (const [nodeId, deg] of inDegreeCopy.entries()) {
      if (deg === 0) {
        queue.push(nodeId);
      }
    }

    while (queue.length > 0) {
      const currentId = queue.shift();
      executionPlan.push(currentId);

      for (const neighbor of adjList.get(currentId)) {
        inDegreeCopy.set(neighbor, inDegreeCopy.get(neighbor) - 1);
        if (inDegreeCopy.get(neighbor) === 0) {
          queue.push(neighbor);
        }
      }
    }

    return executionPlan;
  }
}

const defaultRuleParser = new RuleParser();

module.exports = {
  RuleParser,
  RuleParserError,
  NODE_CATEGORIES,
  VALID_OPERATORS,
  defaultRuleParser,
};
