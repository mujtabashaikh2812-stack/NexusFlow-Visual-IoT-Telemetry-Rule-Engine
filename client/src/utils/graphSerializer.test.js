import assert from "node:assert/strict";
import test from "node:test";
import { deserializeGraph, serializeGraph } from "./graphSerializer.js";

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

test("round-trips nested node data and a multi-branch graph", () => {
  const graph = {
    nodes: [
      {
        id: "source",
        type: "source",
        position: { x: 10, y: 20 },
        data: { device: "Turbine", calibration: { offsets: [1, 2] } },
      },
      {
        id: "transform",
        type: "transform",
        position: { x: 220, y: 20 },
        data: { windowSeconds: 15, samples: [{ secondsAgo: 3, value: 82 }] },
      },
      {
        id: "threshold-a",
        type: "threshold",
        position: { x: 430, y: -70 },
        data: { operator: ">", threshold: 80 },
      },
      {
        id: "threshold-b",
        type: "threshold",
        position: { x: 430, y: 120 },
        data: { operator: "<", threshold: 20 },
      },
      {
        id: "alert-a",
        type: "action",
        position: { x: 640, y: -70 },
        data: { target: "SMS", messageTemplate: "High: {{value}}" },
      },
      {
        id: "alert-b",
        type: "action",
        position: { x: 640, y: 120 },
        data: { target: "Webhook", messageTemplate: "Low: {{value}}" },
      },
    ],
    edges: [
      { id: "source-transform", source: "source", target: "transform" },
      {
        id: "transform-a",
        source: "transform",
        target: "threshold-a",
        sourceHandle: "high",
        targetHandle: "input",
        data: { condition: { operator: ">", threshold: 80 } },
      },
      { id: "transform-b", source: "transform", target: "threshold-b" },
      { id: "a-alert", source: "threshold-a", target: "alert-a" },
      { id: "b-alert", source: "threshold-b", target: "alert-b" },
    ],
  };

  const restored = deserializeGraph(
    JSON.stringify(serializeGraph(graph.nodes, graph.edges)),
  );

  assert.deepEqual(restored, graph);
  assert.notStrictEqual(
    restored.nodes[0].data.calibration,
    graph.nodes[0].data.calibration,
  );
  assert.notStrictEqual(
    restored.nodes[1].data.samples,
    graph.nodes[1].data.samples,
  );
  assert.notStrictEqual(restored.edges[1].data, graph.edges[1].data);
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

test("rejects malformed or invalid saved graph data", () => {
  assert.throws(
    () => deserializeGraph("{"),
    /saved data is not valid JSON/,
  );
  assert.throws(
    () =>
      deserializeGraph(
        JSON.stringify({
          nodes,
          edges: [{ id: "missing-source", source: "missing", target: "action" }],
        }),
      ),
    /unknown source node/,
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
