export function isConnectionAllowed(connection, nodes) {
  const sourceNode = nodes.find((node) => node.id === connection.source);
  const targetNode = nodes.find((node) => node.id === connection.target);

  if (!sourceNode || !targetNode) {
    return false;
  }

  return !(sourceNode.type === "output" && targetNode.type === "input");
}
