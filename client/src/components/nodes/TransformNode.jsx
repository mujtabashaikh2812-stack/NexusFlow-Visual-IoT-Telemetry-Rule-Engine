import { Handle, Position, useReactFlow } from "@xyflow/react";
import { Activity, TrendingUp } from "lucide-react";
import "./TransformNode.css";

const windows = [
  { value: 5, label: "5 seconds" },
  { value: 15, label: "15 seconds" },
  { value: 60, label: "60 seconds" },
];

const exampleSamples = [
  { secondsAgo: 0, value: 76 },
  { secondsAgo: 3, value: 82 },
  { secondsAgo: 8, value: 74 },
  { secondsAgo: 13, value: 79 },
  { secondsAgo: 21, value: 71 },
  { secondsAgo: 42, value: 75 },
  { secondsAgo: 58, value: 73 },
  { secondsAgo: 75, value: 80 },
];

function formatValue(value) {
  return Number(value.toFixed(2)).toString();
}

export default function TransformNode({ id, data }) {
  const { updateNodeData } = useReactFlow();
  const windowSeconds = windows.some(
    (option) => option.value === Number(data.windowSeconds),
  )
    ? Number(data.windowSeconds)
    : 15;
  const samples = Array.isArray(data.samples) ? data.samples : exampleSamples;
  const windowSamples = samples.filter(
    (sample) =>
      Number.isFinite(sample?.secondsAgo) &&
      Number.isFinite(sample?.value) &&
      sample.secondsAgo >= 0 &&
      sample.secondsAgo <= windowSeconds,
  );
  const average =
    windowSamples.length > 0
      ? windowSamples.reduce((sum, sample) => sum + sample.value, 0) /
        windowSamples.length
      : null;

  return (
    <article className="transform-node" aria-label="Moving average transform node">
      <Handle type="target" position={Position.Left} />

      <div className="transform-node-heading">
        <span className="transform-node-icon" aria-hidden="true">
          <TrendingUp size={16} />
        </span>
        <div>
          <p className="transform-node-eyebrow">TRANSFORM</p>
          <h3>Moving average</h3>
        </div>
      </div>

      <label className="transform-node-field">
        <span>Smoothing window</span>
        <select
          className="nodrag"
          aria-label="Smoothing window"
          value={windowSeconds}
          onChange={(event) =>
            updateNodeData(id, { windowSeconds: Number(event.target.value) })
          }
        >
          {windows.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <section
        className="transform-node-preview"
        aria-label={`Moving average preview for the last ${windowSeconds} seconds`}
        aria-live="polite"
      >
        <div className="transform-node-preview-heading">
          <Activity size={13} aria-hidden="true" />
          <span>Smoothed output</span>
          <span className="transform-node-sample-count">
            {windowSamples.length} {windowSamples.length === 1 ? "sample" : "samples"}
          </span>
        </div>
        {average === null ? (
          <p className="transform-node-empty">Waiting for samples</p>
        ) : (
          <>
            <strong className="transform-node-average">{formatValue(average)}</strong>
            <p className="transform-node-formula">
              ({windowSamples.map((sample) => formatValue(sample.value)).join(" + ")})
              {" / "}
              {windowSamples.length}
            </p>
          </>
        )}
      </section>

      <Handle type="source" position={Position.Right} />
    </article>
  );
}
