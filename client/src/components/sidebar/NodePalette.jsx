import {
  Activity,
  Bell,
  Clock3,
  Filter,
  Gauge,
  Mail,
  Radio,
  Zap,
} from "lucide-react";

const categories = [
  {
    name: "Sources",
    nodes: [
      { label: "Telemetry", type: "input", icon: Radio },
      { label: "Sensor reading", type: "input", icon: Activity },
      { label: "Threshold value", type: "input", icon: Gauge },
    ],
  },
  {
    name: "Logic",
    nodes: [
      { label: "Condition", type: "default", icon: Filter },
      { label: "Delay", type: "default", icon: Clock3 },
      { label: "Transform", type: "default", icon: Zap },
    ],
  },
  {
    name: "Actions",
    nodes: [
      { label: "Send alert", type: "output", icon: Bell },
      { label: "Send email", type: "output", icon: Mail },
    ],
  },
];

function handleDragStart(event, node) {
  event.dataTransfer.setData("application/reactflow", node.type);
  event.dataTransfer.setData("application/reactflow-label", node.label);
  event.dataTransfer.effectAllowed = "copy";
}

export default function NodePalette() {
  return (
    <aside className="node-palette" aria-label="Node palette">
      <div className="palette-heading">
        <h2>Node palette</h2>
        <p>Drag a node onto the canvas</p>
      </div>

      <div className="palette-categories">
        {categories.map((category) => (
          <section
            className="palette-category"
            key={category.name}
            aria-labelledby={`palette-${category.name.toLowerCase()}`}
          >
            <h3 id={`palette-${category.name.toLowerCase()}`}>
              {category.name}
            </h3>
            <div className="palette-node-list">
              {category.nodes.map((node) => {
                const Icon = node.icon;

                return (
                  <button
                    className={`palette-node palette-node-${node.type}`}
                    key={node.label}
                    type="button"
                    draggable
                    onDragStart={(event) => handleDragStart(event, node)}
                    aria-label={`Drag ${node.label} node onto the canvas`}
                  >
                    <span className="palette-node-icon" aria-hidden="true">
                      <Icon size={15} />
                    </span>
                    <span>{node.label}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}
