import assert from "node:assert/strict";
import test from "node:test";
import { serializeGraph } from "./graphSerializer.js";

const nodes = [
  { id: "source", type: "source", position: { x: 10, y: 20 }, data: { device: "Turbine" } },
  { id: "action", type: "action", position: { x: 30, y: 40 }, data: { target: "SMS" } },
];
const edges = [{ id: "source-action", source: "source", target: "action" }];

test("serializes the complete node and edge topology without changing input", () => {
  const graph = serializeGraph(nodes, edges);

  assert.deepEqual(graph, { nodes, edges });
  assert.notStrictEqual(graph.nodes, nodes);
  assert.notStrictEqual(graph.edges, edges);
});

test("rejects duplicate node and edge identifiers", () => {
  assert.throws(
    () => serializeGraph([nodes[0], nodes[0]], []),
    /Duplicate node id/,
  );
  assert.throws(
    () =>
      serializeGraph(nodes, [
        edges[0],
        { ...edges[0], source: "action", target: "source" },
      ]),
    /Duplicate edge id/,
  );
});

test("rejects invalid positions and edges with missing endpoints", () => {
  assert.throws(
    () =>
      serializeGraph(
        [{ ...nodes[0], position: { x: Number.NaN, y: 20 } }],
        [],
      ),
    /finite x and y positions/,
  );
  assert.throws(
    () => serializeGraph(nodes, [{ ...edges[0], target: "missing" }]),
    /unknown target node/,
  );
});
