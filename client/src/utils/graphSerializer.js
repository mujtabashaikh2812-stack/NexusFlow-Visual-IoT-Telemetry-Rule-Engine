function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireUniqueId(item, index, kind, ids) {
  if (!isObject(item) || typeof item.id !== "string" || item.id.trim() === "") {
    throw new Error(`${kind} at index ${index} must have a non-empty string id.`);
  }

  if (ids.has(item.id)) {
    throw new Error(`Duplicate ${kind.toLowerCase()} id "${item.id}".`);
  }

  ids.add(item.id);
}

function validateGraph(nodes, edges) {
  if (!Array.isArray(nodes)) {
    throw new Error("nodes must be an array.");
  }

  if (!Array.isArray(edges)) {
    throw new Error("edges must be an array.");
  }

  const nodeIds = new Set();
  nodes.forEach((node, index) => {
    requireUniqueId(node, index, "Node", nodeIds);

    if (
      !isObject(node.position) ||
      !Number.isFinite(node.position.x) ||
      !Number.isFinite(node.position.y)
    ) {
      throw new Error(`Node "${node.id}" must have finite x and y positions.`);
    }
  });

  const edgeIds = new Set();
  edges.forEach((edge, index) => {
    requireUniqueId(edge, index, "Edge", edgeIds);

    if (typeof edge.source !== "string" || !nodeIds.has(edge.source)) {
      throw new Error(`Edge "${edge.id}" references an unknown source node.`);
    }

    if (typeof edge.target !== "string" || !nodeIds.has(edge.target)) {
      throw new Error(`Edge "${edge.id}" references an unknown target node.`);
    }
  });
}

function cloneGraph(nodes, edges, operation) {
  try {
    return JSON.parse(JSON.stringify({ nodes, edges }));
  } catch (error) {
    throw new Error(
      `Cannot ${operation} graph: graph data is not JSON-serializable (${error.message})`,
    );
  }
}

export function serializeGraph(nodes, edges) {
  try {
    validateGraph(nodes, edges);
  } catch (error) {
    throw new Error(`Cannot export graph: ${error.message}`);
  }
  return cloneGraph(nodes, edges, "export");
}

export function deserializeGraph(serializedGraph) {
  let graph;
  try {
    graph = JSON.parse(serializedGraph);
  } catch {
    throw new Error("Cannot restore graph: saved data is not valid JSON.");
  }

  if (!isObject(graph)) {
    throw new Error("Cannot restore graph: saved data must be an object.");
  }

  try {
    validateGraph(graph.nodes, graph.edges);
  } catch (error) {
    throw new Error(`Cannot restore graph: ${error.message}`);
  }

  return cloneGraph(graph.nodes, graph.edges, "restore");
}
