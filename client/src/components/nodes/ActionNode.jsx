import { Handle, Position, useReactFlow } from "@xyflow/react";
import { Send } from "lucide-react";
import "./ActionNode.css";

const targets = ["SMS", "Webhook", "Email"];
const defaultMessageTemplate =
  "Emergency: {{device}} {{sensorType}} is at {{value}}.";

export default function ActionNode({ id, data }) {
  const { updateNodeData } = useReactFlow();
  const target = targets.includes(data.target) ? data.target : targets[0];
  const messageTemplate =
    data.messageTemplate ?? defaultMessageTemplate;

  return (
    <article className="action-node" aria-label="Action alert dispatcher node">
      <Handle type="target" position={Position.Left} />

      <div className="action-node-heading">
        <span className="action-node-icon" aria-hidden="true">
          <Send size={16} />
        </span>
        <div>
          <p className="action-node-eyebrow">ACTION</p>
          <h3>Alert dispatcher</h3>
        </div>
        <span className="action-node-priority" aria-label="Emergency priority">
          Emergency
        </span>
      </div>

      <label className="action-node-field">
        <span>Delivery target</span>
        <select
          className="nodrag"
          aria-label="Alert delivery target"
          value={target}
          onChange={(event) =>
            updateNodeData(id, { target: event.target.value })
          }
        >
          {targets.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="action-node-field">
        <span>Message template</span>
        <textarea
          className="nodrag"
          aria-label="Alert message template"
          rows={3}
          value={messageTemplate}
          onChange={(event) =>
            updateNodeData(id, { messageTemplate: event.target.value })
          }
        />
      </label>

      <Handle type="source" position={Position.Right} />
    </article>
  );
}
