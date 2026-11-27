import { useEffect, useRef, useState } from "react";
import { BaseEdge, getSmoothStepPath } from "@xyflow/react";
import { useLiveValues } from "../nodes/LiveValueBadge.jsx";
import "./GlowingEdge.css";

export default function GlowingEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  interactionWidth,
}) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
  });
  const { isConnected, values } = useLiveValues();
  const previousValues = useRef(values);
  const [pulseId, setPulseId] = useState(0);

  useEffect(() => {
    const hasNewReading = Object.keys({ ...previousValues.current, ...values })
      .some((sensorType) => previousValues.current[sensorType] !== values[sensorType]);
    previousValues.current = values;

    if (isConnected && hasNewReading) {
      setPulseId((currentPulseId) => currentPulseId + 1);
    }
  }, [isConnected, values]);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={interactionWidth}
      />
      {pulseId > 0 && (
        <>
          <path
            key={`glow-${pulseId}`}
            d={edgePath}
            className="glowing-edge-glow"
          />
          <path
            key={`dash-${pulseId}`}
            d={edgePath}
            pathLength="100"
            className="glowing-edge-dash"
          />
          <circle
            key={`particle-${pulseId}`}
            r="3"
            className="glowing-edge-particle"
          >
            <animateMotion
              dur="850ms"
              repeatCount="1"
              path={edgePath}
            />
            <animate
              attributeName="opacity"
              values="0;1;1;0"
              dur="850ms"
              fill="freeze"
            />
          </circle>
        </>
      )}
    </>
  );
}
