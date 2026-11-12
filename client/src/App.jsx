import { GitBranch, Network, Radio } from "lucide-react";
import RuleCanvas from "./components/canvas/RuleCanvas.jsx";

export default function App() {
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
          <span className="connection-status">
            <Radio size={14} />
            Canvas ready
          </span>
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
            <span className="draft-badge"><span /> Unsaved draft</span>
          </div>
        </section>

        <section className="canvas-frame" aria-label="Visual rule canvas">
          <RuleCanvas />
          <div className="canvas-hint">
            <span className="hint-key">Drag</span> to move nodes
            <span className="hint-separator">·</span>
            <span className="hint-key">Scroll</span> to zoom
            <span className="hint-separator">·</span>
            Drag empty space to pan
          </div>
        </section>
      </main>
    </div>
  );
}
