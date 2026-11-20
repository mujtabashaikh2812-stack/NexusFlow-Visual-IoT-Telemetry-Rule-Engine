import { useState } from "react";
import { Download } from "lucide-react";
import { serializeGraph } from "../../utils/graphSerializer.js";

export default function Toolbar({ graphRef }) {
  const [error, setError] = useState("");

  function handleExport() {
    try {
      const { nodes, edges } = graphRef.current;
      const payload = serializeGraph(nodes, edges);
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = `nexusflow-graph-${new Date().toISOString().slice(0, 10)}.json`;
      try {
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setError("");
    } catch (exportError) {
      setError(exportError.message || "Unable to export the graph.");
    }
  }

  return (
    <div className="toolbar">
      <button
        className="export-button"
        type="button"
        onClick={handleExport}
        aria-label="Export graph as JSON"
        title="Export graph as JSON"
      >
        <Download size={15} />
        Export JSON
      </button>
      {error && (
        <span className="export-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
