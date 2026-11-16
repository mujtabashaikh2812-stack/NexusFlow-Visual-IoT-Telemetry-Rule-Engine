import { Handle, Position, useReactFlow } from "@xyflow/react";
import { Activity, Radio } from "lucide-react";
import "./SourceNode.css";

const devices = ["Turbine", "Boiler", "Generator"];
const sensorTypes = ["Temperature", "Pressure", "Vibration", "Flow rate"];

export default function SourceNode({ id, data }) {
  const { updateNodeData } = useReactFlow();
  const device = data.device ?? devices[0];
  const sensorType = data.sensorType ?? sensorTypes[0];

  return (
    <article className="source-node" aria-label="Data source node">
      <Handle type="target" position={Position.Left} />

      <div className="source-node-heading">
        <span className="source-node-icon" aria-hidden="true">
          <Activity size={16} />
        </span>
        <div>
          <p className="source-node-eyebrow">DATA SOURCE</p>
          <h3>Telemetry</h3>
        </div>
        <span className="source-node-status" aria-label="Device status: live">
          <span className="source-node-status-dot" />
          Live
        </span>
      </div>

      <label className="source-node-field">
        <span>Device</span>
        <select
          className="nodrag"
          aria-label="Device"
          value={device}
          onChange={(event) => updateNodeData(id, { device: event.target.value })}
        >
          {devices.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="source-node-field">
        <span>Sensor type</span>
        <select
          className="nodrag"
          aria-label="Sensor type"
          value={sensorType}
          onChange={(event) =>
            updateNodeData(id, { sensorType: event.target.value })
          }
        >
          {sensorTypes.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <div className="source-node-connection">
        <Radio size={13} aria-hidden="true" />
        <span>Streaming telemetry</span>
      </div>

      <Handle type="source" position={Position.Right} />
    </article>
  );
}
