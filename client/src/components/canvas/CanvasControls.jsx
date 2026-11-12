import { Maximize, Minus, Plus } from "lucide-react";
import { useReactFlow } from "@xyflow/react";

export default function CanvasControls() {
  const { fitView, zoomIn, zoomOut } = useReactFlow();

  return (
    <div className="canvas-controls" aria-label="Canvas controls">
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => zoomIn({ duration: 180 })}
      >
        <Plus size={16} />
      </button>
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => zoomOut({ duration: 180 })}
      >
        <Minus size={16} />
      </button>
      <span className="control-divider" aria-hidden="true" />
      <button
        type="button"
        aria-label="Fit graph to view"
        title="Fit graph to view"
        onClick={() => fitView({ padding: 0.3, duration: 220 })}
      >
        <Maximize size={15} />
      </button>
    </div>
  );
}
