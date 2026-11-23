# NexusFlow: Visual IoT Telemetry & Rule Engine

> Enterprise-grade real-time IoT sensor telemetry ingestion platform, visual drag-and-drop rule engine, and interactive device monitoring dashboard.

---

## 📌 Project Overview
- **Project**: NexusFlow - Visual IoT Telemetry & Rule Engine
- **Organization**: Infotact Solutions (Internship Project - Month 2)
- **Role**: Associate L1. Intern (Web Development)
- **Team Lead**: Shaikh Mohd Mujtaba Sadique Ahmed
- **Duration**: 10 November 2026 – 10 December 2026

---

## 👥 Development Pod Branches
- **`main`**: Production-ready, verified releases and merged stable builds.
- **`lead-mujtaba`**: Architectural core, real-time ingestion pipelines, rule execution coordinator, DevOps.
- **`dev-santosh`**: Telemetry ingestion gateway, MQTT/WebSocket sensor adapters, data stream parsers.
- **`dev-akhila`**: Interactive visual rule builder canvas, drag-and-drop node graph UI, telemetry charts.
- **`dev-kuldeep`**: Time-series database schemas, historical sensor logging, device registry, alert persistence.

---

## 🛠️ Technology Stack (Planned)
- **Backend**: Node.js, Express, WebSockets, MQTT Protocol Bridge
- **Rule Engine**: Abstract Syntax Tree (AST) evaluator, condition threshold processors, action dispatchers
- **Frontend**: Responsive Telemetry Dashboard, Canvas/SVG Node Graph Rule Builder, Real-Time Gauges & Charts
- **Database**: MongoDB / Time-Series Database, Redis Event Queue
- **DevOps**: Docker, Health Monitoring, Automated Verification Test Suite

---

## 💻 Frontend Quick Start

The React/Vite visual rule canvas is in `client/`.

```powershell
cd client
npm install
npm run dev
```

The starter canvas uses React Flow with a dark CSS theme, draggable sample nodes,
connectable edges, zoom and pan controls, and a minimap. Run `npm run build` in
`client/` to verify the production bundle. The canvas saves validated node and
edge snapshots in browser-local storage and restores them on reload; use
**Export JSON** to download a portable copy of the complete graph.

### WebSocket telemetry stream

The client connects to `ws://localhost:3000` by default. Set `VITE_WS_URL` in
`client/.env.local` to override the WebSocket server URL (use `wss://` for secure
deployments). On connection, the client sends:

```json
{ "type": "subscribe", "channels": ["telemetry:stream", "rule:triggered"] }
```

The server should publish JSON event envelopes, for example
`{"event":"telemetry:stream","data":{"deviceId":"turbine-01","timestamp":"2026-11-23T12:00:00Z","sensorType":"temperature","value":82,"unit":"°C"}}`
and
`{"event":"rule:triggered","data":{"ruleId":"overheat","message":"Temperature threshold exceeded"}}`.
The client also accepts `channel` with a `payload`, or `type` with a `data` field.
Telemetry events may be a temperature/vibration pair or individual sensor
readings; individual readings are combined for the live chart. The connection
status and latest rule trigger are shown in the dashboard.

---

## 📄 License
This project is proprietary and confidential to **Infotact Solutions**.
