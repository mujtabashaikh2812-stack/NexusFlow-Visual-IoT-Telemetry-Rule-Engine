# NexusFlow: Visual IoT Telemetry & Rule Engine
## Mid-Project Architectural & Performance Audit Report (Review 1 Milestone)

> **Document Version:** `1.0.0`  
> **Evaluation Period:** Days 1 – 11 (10 Nov 2026 – 21 Nov 2026)  
> **Team Lead & Systems Architect:** Shaikh Mohd Mujtaba Sadique Ahmed ([`@mujtabashaikh2812-stack`](https://github.com/mujtabashaikh2812-stack))  
> **Dedicated Branch:** `lead-mujtaba`  
> **Internship Ref No:** `ITS/WEB/1893` | **Organization:** Infotact Solutions (Electronic City, Bengaluru)  
> **Review Status:** ✅ 4/4 Checklist Complete (100% Eligible for MID Review)

---

### 1. Executive Summary

NexusFlow is an enterprise-grade IoT telemetry ingestion gateway and reactive rule evaluation engine built on Node.js and WebSocket streams. Over the initial 11 sprint days, the core architectural spine has transitioned from initial topology definition to a production-ready, low-latency stream processing engine.

As of Day 11, the platform satisfies all foundational service-level agreements (SLAs), achieving sub-millisecond per-reading evaluation latency, automated DAG validation, zero-downtime hot-reloading, and token-bucket ingress firewalls.

---

### 2. High-Performance Benchmark Audit (Day 11)

To validate the runtime performance of the reactive rule engine under enterprise telemetry load, an automated benchmark test suite (`tests/benchmarks/ruleEngineBenchmark.js`) was authored and executed.

#### 📊 Workload Profile
- **Active Compiled Rules:** `50 concurrent rules` (Linear thresholds, Moving Average transforms, and Rate-of-Change derivative transforms).
- **Simulated Ingestion Volume:** `10,000 continuous readings`.
- **Sensor Diversity:** 10 simulated hardware devices across 5 sensor dimensions (`temperature`, `pressure`, `vibration`, `humidity`, `voltage`).

#### ⚡ Audit Results & SLA Comparison

| Benchmark Metric | Target SLA | Measured Benchmark Result | Status |
| :--- | :---: | :---: | :---: |
| **Average Latency / Reading** | `< 1.0 ms` | **`0.595 ms` (595 µs)** | ✅ Exceeded |
| **Median Latency (p50)** | `< 0.5 ms` | **`0.203 ms` (203 µs)** | ✅ Exceeded |
| **90th Percentile (p90)** | `< 1.0 ms` | **`0.657 ms`** | ✅ Exceeded |
| **95th Percentile (p95)** | `< 2.5 ms` | **`1.415 ms`** | ✅ Exceeded |
| **Ingestion Throughput** | `> 1,000 req/s` | **`1,680 readings / sec`** | ✅ Exceeded |
| **Triggered Alert Actions** | Accurate match | **`31,278 alerts processed`** | ✅ 100% Pass |
| **Heap Memory Overhead** | `< 20 MB` | **`1.68 MB delta`** | ✅ Zero Leaks |

---

### 3. Architecture & Subsystems Review

```
[IoT Hardware Sensors] ---> [HTTP /api/telemetry/ingest]
                                   │
                                   ▼
             ┌───────────────────────────────────────────┐
             │ Token Bucket Ingestion Firewall (O(1))    │
             │   - Per-device throttling (429 + Retry)   │
             │   - Backpressure Load Shedding (503)      │
             └─────────────────────┬─────────────────────┘
                                   │
                                   ▼
             ┌───────────────────────────────────────────┐
             │ Reactive In-Memory Rule Evaluator         │
             │   - DAG AST Execution Plan (Kahn's Sort)  │
             │   - Rolling Window Moving Average         │
             │   - Gradient Derivative Transform (dV/dt) │
             │   - Multi-condition Boolean Logic (AND/OR)│
             └─────────────────────┬─────────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
       [Socket.io Broadcast]          [Disk Persistence Store]
      (telemetry:stream, alerts)     (Atomic JSON + SHA-256 Checksums)
```

1. **Gateway & Real-Time Engine (Days 1–3):** Express HTTP bootstrap with dynamic CORS whitelist, in-memory `ConnectionRegistry`, and real-time Socket.io engine isolating operator dashboards and telemetry streams.
2. **Visual AST Parser & Cycle Detector (Day 4):** Validates raw React Flow visual canvas JSON, enforces node category constraints, prevents circular references via Kahn's topological sort algorithm, and compiles sequential `executionPlan` arrays.
3. **Reactive In-Memory Rule Evaluator (Days 5–8):** High-throughput stream processor supporting sliding window average buffers, rate-of-change gradient transforms ($dV/dt$), and multi-input boolean logic gates (AND, OR, NOT, NAND, NOR, XOR).
4. **Persistence & Hot-Reload Engine (Days 6 & 9):** Atomic file-backed disk storage with SHA-256 integrity verification and zero-downtime hot-reloading (`PUT /api/rules/:ruleId`), dynamically migrating state while preserving rolling buffers and active cooldown timers.
5. **Ingress Protection & Backpressure Monitor (Day 10):** Token Bucket rate-limiting middleware enforcing device-level isolation and server-wide aggregate protection against sensor spam.

---

### 4. Pod Governance & Branch Topology

Under the lead branch strategy, all feature additions are strictly isolated on `lead-mujtaba` to prevent unreviewed mutations on `main`.

- **`lead-mujtaba`:** 100% unit & integration test pass rate (93/93 passing tests).
- **`dev-santosh`:** Ingestion gateway endpoints and batch queue adapters.
- **`dev-akhila`:** React Flow visual editor frontend, custom node drag-and-drop palettes, glowing edge triggers.
- **`dev-kuldeep`:** MongoDB 5.0+ time-series collection schemas and aggregation pipelines.

---

### 5. Roadmap for Weeks 3 & 4 (Days 12–22)

- **Days 12–13:** Resilient Outbound Webhook Dispatcher with exponential backoff, HMAC signature headers, and mock SMS/Slack notification adapters.
- **Days 14–15:** Finite State Machine (FSM) node engine to eliminate alert flapping on noisy sensor boundaries, and high-resolution execution audit loggers.
- **Days 16–17:** Cross-pod integration checkpoints with Santosh (Batch Ingest), Kuldeep (Time-Series DB), and Akhila (Visual Canvas).
- **Days 18–19:** Docker containerization, `docker-compose.yml` multi-container architecture, and Helmet OWASP security hardening.
- **Days 20–22:** Full 20-day streak audit verification, load testing, and grand integration merge into `main` for release `v1.0.0`.
