import { Handle, Position, useReactFlow } from "@xyflow/react";
import { Activity, Filter } from "lucide-react";
import "./ThresholdNode.css";

const operators = [
  { value: ">", label: "Greater than" },
  { value: "<", label: "Less than" },
  { value: "==", label: "Equal to" },
];

function evaluate(value, operator, threshold) {
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) {
    return null;
  }

  switch (operator) {
    case ">":
      return value > threshold;
    case "<":
      return value < threshold;
    case "==":
      return value === threshold;
    default:
      return null;
  }
}

export default function ThresholdNode({ id, data }) {
  const { updateNodeData } = useReactFlow();
  const operator = data.operator ?? ">";
  const threshold = data.threshold ?? 80;
  const currentValue = Number(data.currentValue ?? 76);
  const thresholdNumber =
    threshold === "" ? Number.NaN : Number(threshold);
  const result = evaluate(currentValue, operator, thresholdNumber);
  const resultLabel =
    result === null ? "Waiting" : result ? "Match" : "No match";

  return (
    <article className="threshold-node" aria-label="Threshold comparator node">
      <Handle type="target" position={Position.Left} />

      <div className="threshold-node-heading">
        <span className="threshold-node-icon" aria-hidden="true">
          <Filter size={16} />
        </span>
        <div>
          <p className="threshold-node-eyebrow">LOGIC</p>
          <h3>Threshold</h3>
        </div>
        <span
          className={`threshold-node-result threshold-node-result-${result === null ? "waiting" : result ? "match" : "no-match"}`}
          aria-live="polite"
          aria-label={`Evaluation: ${resultLabel}`}
        >
          {resultLabel}
        </span>
      </div>

      <div className="threshold-node-reading" aria-label={`Latest reading: ${currentValue}`}>
        <Activity size={13} aria-hidden="true" />
        <span>Latest reading</span>
        <strong>{currentValue}</strong>
      </div>

      <label className="threshold-node-field">
        <span>Operator</span>
        <select
          className="nodrag"
          aria-label="Comparison operator"
          value={operator}
          onChange={(event) =>
            updateNodeData(id, { operator: event.target.value })
          }
        >
          {operators.map((option) => (
            <option key={option.value} value={option.value}>
              {option.value} · {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="threshold-node-field">
        <span>Threshold</span>
        <input
          className="nodrag"
          aria-label="Threshold value"
          type="number"
          step="any"
          value={threshold}
          onChange={(event) =>
            updateNodeData(id, { threshold: event.target.value })
          }
        />
      </label>

      <Handle type="source" position={Position.Right} />
    </article>
  );
}
