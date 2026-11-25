import { useRef, useState } from "react";
import { GitBranch, Network, Radio, TriangleAlert } from "lucide-react";
import RuleCanvas from "./components/canvas/RuleCanvas.jsx";
import DeviceFleetWidget from "./components/dashboard/DeviceFleetWidget.jsx";
import TelemetryChart from "./components/dashboard/TelemetryChart.jsx";
import Toolbar from "./components/header/Toolbar.jsx";
import NodePalette from "./components/sidebar/NodePalette.jsx";
import useTelemetryStream from "./hooks/useTelemetryStream.js";

export default function App() {
  const graphRef = useRef({ nodes: [], edges: [] });
  const [persistenceStatus, setPersistenceStatus] = useState("Unsaved draft");
  const {
    connectionError,
    connectionStatus,
    fleetDevices,
    lastRuleTriggered,
    latestSensorValues,
    telemetry,
  } = useTelemetryStream();
  const connectionLabel = {
    connected: "WebSocket connected",
    connecting: "Connecting to stream",
    reconnecting: "Reconnecting to stream",
    error: "WebSocket error",
    disconnected: "Stream disconnected",
  }[connectionStatus];
  const rulePayload = lastRuleTriggered?.payload;
  const ruleSummary =
    typeof rulePayload === "string"
      ? rulePayload
      : rulePayload?.message ??
        rulePayload?.ruleName ??
        rulePayload?.name ??
        rulePayload?.ruleId ??
        "A rule condition was triggered.";

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="NexusFlow home">
          <span className="brand-mark">
            <Network size={20} strokeWidth={2.2} />
          </span>
          <span className="brand-name">nexus<span>flow</span></span>
        </a>

        <div className="header-meta">
          <span className="connection-status" data-state={connectionStatus}>
            <Radio size={14} aria-hidden="true" />
            {connectionLabel}
          </span>
          {connectionError && (
            <span
              className="connection-error"
              role="alert"
              title={connectionError}
            >
              {connectionError}
            </span>
          )}
          <Toolbar graphRef={graphRef} />
          <span className="branch-badge">
            <GitBranch size={14} />
            dev-akhila
          </span>
        </div>
      </header>

      <main className="main-content">
        <section className="page-heading" aria-labelledby="page-title">
          <div className="eyebrow">VISUAL STUDIO <span>/</span> RULE BUILDER</div>
          <div className="heading-row">
            <div>
              <h1 id="page-title">Rule canvas</h1>
              <p>Connect telemetry sources, operators, and actions.</p>
            </div>
            <span
              className="draft-badge"
              data-state={
                persistenceStatus.startsWith("Save failed") ||
                persistenceStatus.startsWith("Restore failed")
                  ? "error"
                  : persistenceStatus === "Unsaved draft"
                    ? "pending"
                    : "saved"
              }
              role={
                persistenceStatus.startsWith("Save failed") ||
                persistenceStatus.startsWith("Restore failed")
                  ? "alert"
                  : "status"
              }
              title={persistenceStatus}
            >
              <span />
              {persistenceStatus}
            </span>
          </div>
        </section>

        <div className="workspace-layout">
          <NodePalette />
          <section className="canvas-frame" aria-label="Visual rule canvas">
            <RuleCanvas
              graphRef={graphRef}
              isConnected={connectionStatus === "connected"}
              liveValues={latestSensorValues}
              onPersistenceChange={setPersistenceStatus}
            />
            <div className="canvas-hint">
              <span className="hint-key">Drag</span> to move nodes
              <span className="hint-separator">·</span>
              <span className="hint-key">Scroll</span> to zoom
              <span className="hint-separator">·</span>
              Drag empty space to pan
            </div>
          </section>
        </div>
        {lastRuleTriggered && (
          <div className="rule-event-notice" role="status">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>
              <strong>Rule triggered</strong>
              {ruleSummary}
            </span>
          </div>
        )}
        <DeviceFleetWidget devices={fleetDevices} />
        <TelemetryChart
          data={telemetry}
          isConnected={connectionStatus === "connected"}
        />
      </main>
    </div>
  );
}
