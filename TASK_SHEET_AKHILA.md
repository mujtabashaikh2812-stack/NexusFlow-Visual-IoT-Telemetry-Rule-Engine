# NexusFlow: Visual IoT Telemetry & Rule Engine
## Engineering Task Sheet: Nedunuri Akhila (`dev-akhila`)

> **Assigned Engineer:** Nedunuri Akhila  
> **Role:** Visual Canvas & UI Engineer (Frontend Lead)  
> **Dedicated Branch:** `dev-akhila`  
> **Repository:** [NexusFlow-Visual-IoT-Telemetry-Rule-Engine](https://github.com/mujtabashaikh2812-stack/NexusFlow-Visual-IoT-Telemetry-Rule-Engine)  
> **Evaluation Period:** 10 November 2026 – 10 December 2026 (22 Sprint Days)

---

### 🎯 Primary Scope of Work
You own the **Visual No-Code Programming Studio and Live Dashboard** of NexusFlow:
1. Interactive visual graph builder canvas using **React Flow** with pan, zoom, grid snapping, and minimap.
2. Custom Drag-and-Drop Node Library with three core categories:
   - **Data Sources**: Turbine Sensor, Boiler Temp, Vibration Monitor, Energy Meter.
   - **Math & Operators**: Moving Average Filter, Greater-Than (`>`), Rate-of-Change, Time Window.
   - **Action Triggers**: Send SMS Alert, Webhook Dispatcher, Emergency Power Cutoff, Sound Buzzer.
3. **Graph Serialization**: Exporting visual node diagrams into clean JSON structures for the backend compiler and restoring saved graphs.
4. **Live Telemetry Dashboards**: Embedding live moving charts (Recharts / Chart.js) subscribed to real-time WebSocket feeds.
5. **Visual Feedback & Animation**: Designing **animated glowing/pulsing connection wires** that illuminate when data streams through them in real time!

---

### 📅 Day-by-Day Sprint Breakdown (Days 1 – 22)

#### 🔹 Week 1: Canvas Scaffolding & Setup (Days 1 – 5)
- **Day 1 (Nov 10/11)**: Frontend Scaffolding with React + Vite
  - *Files*: `client/src/App.jsx`, `client/package.json`, `client/vite.config.js`
  - *Tasks*: Initialize clean React + Vite application. Install `@xyflow/react` (React Flow), Lucide icons, and Tailwind/CSS theme.
- **Day 2 (Nov 12)**: Basic React Flow Canvas Integration
  - *Files*: `client/src/components/canvas/RuleCanvas.jsx`, `client/src/components/canvas/CanvasControls.jsx`
  - *Tasks*: Mount React Flow with dark-mode canvas grid, zoom controls, pan navigation, and mini-map widget.
- **Day 3 (Nov 13)**: Node Sidebar Palette (Drag & Drop Drawer)
  - *Files*: `client/src/components/sidebar/NodePalette.jsx`
  - *Tasks*: Create draggable sidebar containing node badges grouped by category (Sources, Logic, Actions) with drag-start event binding.
- **Day 4 (Nov 14)**: Canvas Drop & Auto-Connection Handler
  - *Files*: `client/src/components/canvas/useCanvasDrop.js`
  - *Tasks*: Handle drag-over and drop events on canvas. Calculate dropped coordinate offsets and dynamically instantiate new nodes.
- **Day 5 (Nov 15)**: Custom Edge & Connection Validation
  - *Files*: `client/src/components/canvas/CustomConnectionLine.jsx`
  - *Tasks*: Restrict invalid connections (prevent connecting an Action Output directly to a Data Source Output).

---

#### 🔹 Week 2: Custom Node Library & Graph Serialization (Days 6 – 10)
- **Day 6 (Nov 16)**: Custom Node: Data Source Node
  - *Files*: `client/src/components/nodes/SourceNode.jsx`, `client/src/components/nodes/SourceNode.css`
  - *Tasks*: Build UI block with device dropdown (Turbine, Boiler, Generator), sensor type selector, and live status badge.
- **Day 7 (Nov 17)**: Custom Node: Threshold & Logic Comparator
  - *Files*: `client/src/components/nodes/ThresholdNode.jsx`
  - *Tasks*: Build comparator node with operator selector (`>`, `<`, `==`), numeric threshold input field, and live evaluation pill.
- **Day 8 (Nov 18)**: Custom Node: Moving Average Filter & Transform
  - *Files*: `client/src/components/nodes/TransformNode.jsx`
  - *Tasks*: Build mathematical transformer node with window size selector (5s, 15s, 60s) and smoothing calculation preview.
- **Day 9 (Nov 19)**: Custom Node: Action Alert Dispatcher
  - *Files*: `client/src/components/nodes/ActionNode.jsx`
  - *Tasks*: Build action trigger node with target selector (SMS, Webhook, Email), message template field, and emergency priority badge.
- **Day 10 (Nov 20)**: Graph Serialization (Export to JSON)
  - *Files*: `client/src/utils/graphSerializer.js`, `client/src/components/header/Toolbar.jsx`
  - *Tasks*: Export complete canvas topology into structured JSON payload (`{ nodes: [...], edges: [...] }`) with validation checks.

---

#### 🔹 Mid-Project Review: Day 11 (Nov 21)
- **Day 11 (Nov 21)**: Graph Serialization & Schema Audit
  - *Tasks*: Demonstrate that the canvas serializes complex multi-branch graphs accurately and restores them seamlessly upon page reload.

---

#### 🔹 Week 3: Live Telemetry Dashboards & Real-Time Charts (Days 12 – 16)
- **Day 12 (Nov 22)**: WebSocket Client Integration
  - *Files*: `client/src/services/socketService.js`, `client/src/hooks/useTelemetryStream.js`
  - *Tasks*: Connect frontend to backend WebSocket server. Subscribe to `telemetry:stream` and `rule:triggered` channels.
- **Day 13 (Nov 23)**: Real-Time Telemetry Waveform Gauge
  - *Files*: `client/src/components/dashboard/TelemetryChart.jsx`
  - *Tasks*: Embed live rolling line chart (Recharts) plotting temperature/vibration with a 30-second rolling sliding window.
- **Day 14 (Nov 24)**: Live Sensor Value Badges on Canvas Nodes
  - *Files*: `client/src/components/nodes/LiveValueBadge.jsx`
  - *Tasks*: Display live sensor values directly on the custom canvas nodes in real time as data arrives over WebSockets.
- **Day 15 (Nov 25)**: Device Fleet Status Panel
  - *Files*: `client/src/components/dashboard/DeviceFleetWidget.jsx`
  - *Tasks*: Render summary cards showing active IoT devices, battery level, online/offline status, and signal strength.
- **Day 16 (Nov 26)**: In-App Alert Notification Toast & Drawer
  - *Files*: `client/src/components/alerts/AlertNotificationToast.jsx`
  - *Tasks*: Render visual toast notification with audio chime whenever a rule condition is breached (`rule:triggered`).

---

#### 🔹 Week 4: Animated Glowing Wires, Responsive Polish & Release (Days 17 – 22)
- **Day 17 (Nov 27)**: Animated Glowing Data-Flow Wires (SVG Animation)
  - *Files*: `client/src/components/edges/GlowingEdge.jsx`, `client/src/components/edges/GlowingEdge.css`
  - *Tasks*: Custom SVG animated edge with glowing stroke dash-array and particle pulse effect that animates whenever data flows along the wire!
- **Day 18 (Nov 28)**: Alert Condition Breach Wire Highlight
  - *Files*: `client/src/components/edges/AlertEdge.jsx`
  - *Tasks*: Dynamically switch wire color from electric cyan `#38bdf8` to alert red `#ef4444` when a rule triggers an active anomaly!
- **Day 19 (Nov 29)**: Mobile & Tablet Responsive Layout
  - *Files*: `client/src/App.css`
  - *Tasks*: Responsive breakpoints for mobile/tablets: collapsible node palette drawer, touch-to-drag canvas, and stacked chart views.
- **Day 20 (Nov 30)**: Rule Library & Template Preset Browser
  - *Files*: `client/src/components/templates/RuleTemplatesModal.jsx`
  - *Tasks*: Pre-built visual templates (e.g., "Turbine Overheat Protection", "Boiler Pressure Spike Alarm") loadable with 1 click.
- **Day 21 (Dec 01)**: Comprehensive Frontend UI Test Suite
  - *Files*: `client/src/tests/RuleCanvas.test.jsx`, `client/src/tests/serializer.test.js`
  - *Tasks*: Unit test node rendering, drag-and-drop actions, edge serialization, and alert modal triggers.
- **Day 22 (Dec 02)**: Final Branch Integration & Production Build
  - *Tasks*: Merge `dev-akhila` into `main` with Lead Mujtaba, verify clean production build (`npm run build`), and verify live on cloud.

---

### 💻 Daily Git Workflow Instructions

```bash
# 1. Start your day on your branch
git checkout dev-akhila
git pull origin dev-akhila

# 2. Write your code and tests for the day's assigned tasks
# 3. Stage and commit with descriptive Conventional Commit messages (>50 characters)
git add .
git commit -m "feat(canvas): build SourceNode component with sensor dropdown and live badge"

# 4. Push daily to keep your 20-day streak active
git push origin dev-akhila
```
