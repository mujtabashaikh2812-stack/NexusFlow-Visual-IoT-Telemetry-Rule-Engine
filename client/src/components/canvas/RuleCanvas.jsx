import { useCallback } from "react";
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
import ActionNode from "../nodes/ActionNode.jsx";
import SourceNode from "../nodes/SourceNode.jsx";
import ThresholdNode from "../nodes/ThresholdNode.jsx";
import TransformNode from "../nodes/TransformNode.jsx";

const nodeTypes = {
  action: ActionNode,
  source: SourceNode,
  threshold: ThresholdNode,
  transform: TransformNode,
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

const initialEdges = [
  {
    id: "turbine-threshold",
    source: "turbine",
    target: "threshold",
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8" },
  },
  {
    id: "threshold-alert",
    source: "threshold",
    target: "alert",
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8" },
  },
];

function CanvasContent() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
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
            type: "smoothstep",
            markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8" },
          },
          currentEdges,
        ),
      );
    },
    [nodes, setEdges],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
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
  );
}

export default function RuleCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasContent />
    </ReactFlowProvider>
  );
}
