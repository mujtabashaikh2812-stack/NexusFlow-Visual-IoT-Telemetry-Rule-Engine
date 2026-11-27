import { useCallback, useEffect, useRef, useState } from "react";
import {
  addEdge,
  Background,
  BackgroundVariant,
  MiniMap,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import CanvasControls from "./CanvasControls.jsx";
import { isConnectionAllowed } from "./CustomConnectionLine.jsx";
import useCanvasDrop from "./useCanvasDrop.js";
import GlowingEdge from "../edges/GlowingEdge.jsx";
import ActionNode from "../nodes/ActionNode.jsx";
import SourceNode from "../nodes/SourceNode.jsx";
import ThresholdNode from "../nodes/ThresholdNode.jsx";
import TransformNode from "../nodes/TransformNode.jsx";
import { LiveValueProvider } from "../nodes/LiveValueBadge.jsx";
import { deserializeGraph, serializeGraph } from "../../utils/graphSerializer.js";

const nodeTypes = {
  action: ActionNode,
  source: SourceNode,
  threshold: ThresholdNode,
  transform: TransformNode,
};

const edgeTypes = {
  glowing: GlowingEdge,
  smoothstep: GlowingEdge,
};

const initialNodes = [
  {
    id: "turbine",
    type: "source",
    position: { x: 80, y: 170 },
    data: { device: "Turbine", sensorType: "Temperature" },
  },
  {
    id: "threshold",
    type: "threshold",
    position: { x: 410, y: 170 },
    data: { operator: ">", threshold: 80, currentValue: 76 },
  },
  {
    id: "alert",
    type: "action",
    position: { x: 740, y: 170 },
    data: {
      target: "SMS",
      messageTemplate:
        "Emergency: {{device}} {{sensorType}} is at {{value}}.",
    },
  },
];

const GRAPH_STORAGE_KEY = "nexusflow.graph.v1";

const initialEdges = [
  {
    id: "turbine-threshold",
    source: "turbine",
    target: "threshold",
    type: "glowing",
    markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8" },
  },
  {
    id: "threshold-alert",
    source: "threshold",
    target: "alert",
    type: "glowing",
    markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8" },
  },
];

function loadGraph() {
  try {
    const savedGraph = window.localStorage.getItem(GRAPH_STORAGE_KEY);
    if (savedGraph === null) {
      return {
        graph: { nodes: initialNodes, edges: initialEdges },
        restored: false,
      };
    }

    return { graph: deserializeGraph(savedGraph), restored: true };
  } catch (error) {
    return {
      graph: { nodes: initialNodes, edges: initialEdges },
      error: error.message || "Unable to restore the saved graph.",
    };
  }
}

function CanvasContent({ graphRef, isConnected, liveValues, onPersistenceChange }) {
  const [restoreResult] = useState(loadGraph);
  const [nodes, setNodes, onNodesChange] = useNodesState(
    restoreResult.graph.nodes,
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    restoreResult.graph.edges,
  );
  const [persistenceStatus, setPersistenceStatus] = useState(() => {
    if (restoreResult.error) {
      return `Restore failed: ${restoreResult.error}`;
    }
    return restoreResult.restored ? "Restored locally" : "Unsaved draft";
  });
  const skippedInitialSave = useRef(false);
  graphRef.current = { nodes, edges };

  useEffect(() => {
    onPersistenceChange(persistenceStatus);
  }, [onPersistenceChange, persistenceStatus]);

  useEffect(() => {
    if (!skippedInitialSave.current) {
      skippedInitialSave.current = true;
      return;
    }

    try {
      const savedGraph = JSON.stringify(serializeGraph(nodes, edges));
      window.localStorage.setItem(GRAPH_STORAGE_KEY, savedGraph);
      setPersistenceStatus("Saved locally");
    } catch (error) {
      setPersistenceStatus(
        `Save failed: ${error.message || "Unable to save the graph."}`,
      );
    }
  }, [nodes, edges]);

  const { onDragOver, onDrop } = useCanvasDrop(setNodes);
  const onConnect = useCallback(
    (connection) => {
      if (!isConnectionAllowed(connection, nodes)) {
        return;
      }

      setEdges((currentEdges) =>
        addEdge(
          {
            ...connection,
            type: "glowing",
            markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8" },
          },
          currentEdges,
        ),
      );
    },
    [nodes, setEdges],
  );

  return (
    <LiveValueProvider isConnected={isConnected} values={liveValues}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={(connection) => isConnectionAllowed(connection, nodes)}
        onDragOver={onDragOver}
        onDrop={onDrop}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.25}
        maxZoom={1.5}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        nodesDraggable
        nodesConnectable
        elementsSelectable
        defaultEdgeOptions={{
          type: "glowing",
          style: { stroke: "#818cf8", strokeWidth: 2 },
        }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1}
          color="#242c3b"
        />
        <CanvasControls />
        <MiniMap
          className="canvas-minimap"
          nodeColor="#54617a"
          maskColor="rgba(10, 13, 20, 0.72)"
          pannable
          zoomable
        />
      </ReactFlow>
    </LiveValueProvider>
  );
}

export default function RuleCanvas({
  graphRef,
  isConnected,
  liveValues,
  onPersistenceChange,
}) {
  return (
    <ReactFlowProvider>
      <CanvasContent
        graphRef={graphRef}
        isConnected={isConnected}
        liveValues={liveValues}
        onPersistenceChange={onPersistenceChange}
      />
    </ReactFlowProvider>
  );
}
