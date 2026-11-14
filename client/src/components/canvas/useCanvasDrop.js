import { useCallback } from "react";
import { useReactFlow } from "@xyflow/react";

const NODE_TYPES = new Set(["input", "default", "output"]);

export default function useCanvasDrop(setNodes) {
  const { screenToFlowPosition } = useReactFlow();

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();

      const type = event.dataTransfer.getData("application/reactflow");
      const label = event.dataTransfer.getData("application/reactflow-label");

      if (!label || !NODE_TYPES.has(type)) {
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

  return { onDragOver, onDrop };
}
