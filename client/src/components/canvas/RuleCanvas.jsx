import { useCallback } from "react";
import {
  addEdge,
  Background,
  BackgroundVariant,
  MiniMap,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import CanvasControls from "./CanvasControls.jsx";

const initialNodes = [
  {
    id: "turbine",
    type: "input",
    position: { x: 80, y: 170 },
    data: { label: "Turbine sensor" },
  },
  {
    id: "threshold",
    type: "default",
    position: { x: 410, y: 170 },
    data: { label: "Temperature > 80°C" },
  },
  {
    id: "alert",
    type: "output",
    position: { x: 740, y: 170 },
    data: { label: "Send SMS alert" },
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
  const { screenToFlowPosition } = useReactFlow();
  const onConnect = useCallback(
    (connection) =>
      setEdges((currentEdges) =>
        addEdge(
          {
            ...connection,
            type: "smoothstep",
            markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8" },
          },
          currentEdges,
        ),
      ),
    [setEdges],
  );
  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);
  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/reactflow");
      const label = event.dataTransfer.getData("application/reactflow-label");

      if (
        !label ||
        !["input", "default", "output"].includes(type)
      ) {
        return;
      }

      setNodes((currentNodes) => [
        ...currentNodes,
        {
          id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          type,
          position: screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          }),
          data: { label },
        },
      ]);
    },
    [screenToFlowPosition, setNodes],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
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
