# NexusFlow: Visual IoT Telemetry & Rule Engine
## Engineering Task Sheet: Shaikh Mohd Mujtaba (`lead-mujtaba`)

> **Assigned Engineer:** Shaikh Mohd Mujtaba Sadique Ahmed  
> **Role:** Team Lead & Systems Architect  
> **Dedicated Branch:** `lead-mujtaba`  
> **GitHub Handle:** [`@mujtabashaikh2812-stack`](https://github.com/mujtabashaikh2812-stack)  
> **Repository:** [NexusFlow-Visual-IoT-Telemetry-Rule-Engine](https://github.com/mujtabashaikh2812-stack/NexusFlow-Visual-IoT-Telemetry-Rule-Engine)  
> **Evaluation Period:** 10 November 2026 – 10 December 2026 (22 Sprint Days)

---

### 🎯 Primary Scope of Work
As Team Lead and Systems Architect for Group 3, you own the **architectural spine, rule compilation & evaluation engine, and multi-pod integration**:
1. **Core Gateway & Sockets**: Bootstrap the Express HTTP gateway, dynamic CORS policies, and WebSocket real-time communication engine (`src/server.js`, `src/sockets/socketManager.js`).
2. **AST Visual Rule Parser**: Design the Abstract Syntax Tree parser converting React Flow visual graphs into executable directed acyclic graphs (DAG) with cycle detection and topological sorting via Kahn's algorithm (`src/core/ruleParser.js`).
3. **Reactive In-Memory Rule Evaluator**: Build the low-latency stream evaluator that processes continuous sensor streams, calculates rolling window transforms (moving average, scale, offset), evaluates multi-operator conditions (`>`, `<`, `between`, `outside`), and dispatches rate-limited alerts (`src/core/ruleEvaluator.js`).
4. **Integration & Quality Gate**: Author end-to-end unit and integration test suites (`tests/`), maintaining 100% test pass rate.
5. **Sprint Governance & Release**: Supervise engineering pods (`dev-santosh`, `dev-akhila`, `dev-kuldeep`), enforce the mandatory 20-day streak, conduct code reviews, and execute the grand integration merge into `main` on Day 22 for production release `v1.0.0`.

---

### 📅 Day-by-Day Sprint Breakdown (Days 1 – 22)

#### 🔹 Week 1: Core Architecture, Telemetry Engine & In-Memory Evaluator (Days 1 – 5)
- **Day 1 (Nov 10/11)**: Architecture Blueprint & Pod Task Allocation
  - *Files*: `WORK_DISTRIBUTION.md`, `TASK_SHEET_SANTOSH.md`, `TASK_SHEET_AKHILA.md`, `TASK_SHEET_KULDEEP.md`, `.gitignore`, `README.md`
  - *Tasks*: Initialize GitHub repository, define 4-week milestone matrix, create team branches (`lead-mujtaba`, `dev-santosh`, `dev-akhila`, `dev-kuldeep`), and establish 20-day commit streak standards.
- **Day 2 (Nov 12)**: Server Bootstrap, Config & Connection Registry
  - *Files*: `package.json`, `.env.example`, `src/config/serverConfig.js`, `src/core/connectionRegistry.js`
  - *Tasks*: Configure Express gateway with environment variables, dynamic CORS whitelist, and in-memory IoT device & operator session registry.
- **Day 3 (Nov 13)**: WebSocket Engine & Ingestion REST Gateway
  - *Files*: `src/sockets/socketManager.js`, `src/server.js`, `tests/serverBootstrap.test.js`, `tests/socketEngine.test.js`
  - *Tasks*: Implement real-time Socket.io engine with room isolation (`operators`, `alerts:all`), heartbeat tracking, and HTTP fallback telemetry ingestion.
- **Day 4 (Nov 14)**: Visual Graph AST Parser & Cycle Detector
  - *Files*: `src/core/ruleParser.js`, `tests/ruleParser.test.js`
  - *Tasks*: Implement AST visual graph parser, node normalization, connectivity verification, cycle detection (`CYCLE_DETECTED`), and Kahn's topological sort execution plan.
- **Day 5 (Nov 15)**: Reactive In-Memory Rule Evaluator & Rule Management REST Endpoints
  - *Files*: `src/core/ruleEvaluator.js`, `tests/ruleEvaluator.test.js`, `TASK_SHEET_MUJTABA.md`
  - *Tasks*: Build in-memory rule evaluation engine supporting rolling window transforms (moving average), range conditions, action cooldown timers, and deploy/undeploy REST APIs (`/api/rules/deploy`, `/api/rules/active`).

---

#### 🔹 Week 2: Logic Compiler Bridge, Multi-Condition Logic & Pipeline Routing (Days 6 – 10)
- **Day 6 (Nov 16)**: Rule State Persistence & Schema Serialization
  - *Files*: `src/core/ruleStore.js`, `tests/ruleStore.test.js`
  - *Tasks*: Implement file-backed and memory-cached rule persistence layer to preserve deployed pipelines across server restarts.
- **Day 7 (Nov 17)**: Composite Condition Logic (AND / OR Branching)
  - *Files*: `src/core/compositeEvaluator.js`, `tests/compositeEvaluator.test.js`
  - *Tasks*: Extend AST evaluator to support multi-condition logical operators (e.g., `temp > 85 AND vibration > 12`) within branching canvas topologies.
- **Day 8 (Nov 18)**: Rate-of-Change & Derivative Transforms
  - *Files*: `src/core/transforms/derivativeTransform.js`, `tests/derivativeTransform.test.js`
  - *Tasks*: Add derivative/gradient transform calculation (`deltaValue / deltaTime`) to detect rapid sensor spikes prior to absolute threshold breaches.
- **Day 9 (Nov 19)**: Dynamic Rule Hot-Reloading & Validation Middleware
  - *Files*: `src/middleware/ruleValidationMiddleware.js`, `tests/hotReload.test.js`
  - *Tasks*: Enable live atomic rule swapping without interrupting incoming telemetry ingestion streams or losing rolling window buffers.
- **Day 10 (Nov 20)**: Telemetry Ingestion Rate Limiter & Backpressure Monitor
  - *Files*: `src/middleware/rateLimiter.js`, `tests/rateLimiter.test.js`
  - *Tasks*: Implement Token Bucket rate-limiting middleware safeguarding core server from rogue hardware sensor spam (>10,000 req/sec).

---

#### 🔹 Mid-Project Milestone: Full Pipeline Ingestion & Execution Audit (Day 11)
- **Day 11 (Nov 21)**: Mid-Project Audit & Performance Benchmark
  - *Files*: `tests/benchmarks/ruleEngineBenchmark.js`, `docs/MID_PROJECT_AUDIT.md`
  - *Tasks*: Benchmark rule evaluation engine processing 10,000 simulated readings across 50 active rules. Target: sub-1ms evaluation latency per reading.

---

#### 🔹 Week 3: Reactive Webhook Dispatcher, Anomaly Detection & State Machine (Days 12 – 16)
- **Day 12 (Nov 22)**: Outbound Webhook Dispatcher with Exponential Backoff
  - *Files*: `src/alerts/webhookDispatcher.js`, `tests/webhookDispatcher.test.js`
  - *Tasks*: Build resilient HTTP POST webhook dispatcher featuring automated retries, HMAC signature headers, and timeout handling.
- **Day 13 (Nov 23)**: Mock SMS & Email Alert Notification Provider
  - *Files*: `src/alerts/notificationService.js`, `tests/notificationService.test.js`
  - *Tasks*: Implement notification adapter pattern supporting simulated Twilio SMS, Slack webhook alerts, and operational email digests.
- **Day 14 (Nov 24)**: Finite State Machine (FSM) Node Support
  - *Files*: `src/core/stateMachine.js`, `tests/stateMachine.test.js`
  - *Tasks*: Support stateful canvas nodes (`IDLE`, `WARNING`, `CRITICAL`, `RECOVERY`) to eliminate alert flapping on noisy sensor boundaries.
- **Day 15 (Nov 25)**: Execution Audit Logger & Performance Tracing
  - *Files*: `src/core/auditLogger.js`, `tests/auditLogger.test.js`
  - *Tasks*: Record high-resolution execution traces (evaluation latency, condition results, triggered actions) for compliance and debugging.
- **Day 16 (Nov 26)**: Cross-Pod Integration Checkpoint 1 (Santosh & Kuldeep)
  - *Files*: `tests/integration/ingestToStorage.test.js`
  - *Tasks*: Validate seamless telemetry pipeline from Santosh's batch ingestion into Kuldeep's MongoDB Time-Series collections with live rule evaluation.

---

#### 🔹 Week 4: Production Hardening, UI Integration & Grand Release (Days 17 – 22)
- **Day 17 (Nov 27)**: Cross-Pod Integration Checkpoint 2 (Akhila's Visual Canvas)
  - *Files*: `tests/integration/canvasToEngine.test.js`
  - *Tasks*: Verify end-to-end serialization: React Flow canvas JSON export &rarr; AST compilation &rarr; live rule deployment &rarr; glowing wire event trigger.
- **Day 18 (Nov 28)**: Containerization & Docker Compose Architecture
  - *Files*: `Dockerfile`, `docker-compose.yml`, `.dockerignore`
  - *Tasks*: Containerize NexusFlow core server with MongoDB 5.0+ time-series replica set and environment-driven configuration.
- **Day 19 (Nov 29)**: Security Audit, Helmet Headers & Input Sanitization
  - *Files*: `src/middleware/security.js`, `tests/security.test.js`
  - *Tasks*: Enforce OWASP security headers via Helmet, sanitize JSON inputs, and protect against prototype pollution in custom rule configurations.
- **Day 20 (Nov 30)**: 20-Day Streak Milestone & Stipend Compliance Verification
  - *Files*: `docs/STREAK_AUDIT.md`, `scripts/verifyStreaks.js`
  - *Tasks*: Audit commit history across all 4 branches (`lead-mujtaba`, `dev-santosh`, `dev-akhila`, `dev-kuldeep`). Verify 20/20 calendar streak (>50 chars/day).
- **Day 21 (Dec 01)**: Comprehensive Regression & Load Testing
  - *Files*: `tests/load/stressTest.js`, `docs/TEST_REPORT.md`
  - *Tasks*: Execute full test suite (50+ unit and integration tests) under simulated load. Document test coverage report (>95% code coverage).
- **Day 22 (Dec 02)**: Grand Integration Merge into `main`, Tag `v1.0.0` & Deployment
  - *Files*: `CHANGELOG.md`, `RELEASE_NOTES.md`
  - *Tasks*: Review and merge all feature branches (`dev-santosh`, `dev-akhila`, `dev-kuldeep`) into `lead-mujtaba`, execute final verification, merge into `main`, tag `v1.0.0`, and deploy to production cloud.

---

### 📋 Definition of Done (DoD)
- [x] Day 1: Architecture blueprint and pod task sheets committed.
- [x] Day 2/3: Server, dynamic CORS, ConnectionRegistry, and Socket.io engine initialized.
- [x] Day 4: Visual AST parser, cycle detection, and topological execution plan generator delivered.
- [x] Day 5: Reactive in-memory rule evaluator, rolling transforms, and deployment REST APIs operational.
- [x] Day 6: Rule state persistence store, SHA-256 integrity checks, snapshot export/import, and automatic restart recovery.
- [x] Day 7: Composite condition logic (AND, OR, NOT, NAND, NOR, XOR), multi-sensor asynchronous state cache, and windowed evaluation.
- [x] Day 8: Rate-of-change (derivative) telemetry transform, predictive spike detection, and directional gradient filtering.
- [ ] Days 9–10: Dynamic rule hot-reloading and telemetry ingestion rate-limiting.
- [ ] Day 11: Mid-project benchmark (sub-1ms execution latency).
- [ ] Days 12–16: Resilient webhook dispatcher, state machines, and cross-pod stream validation.
- [ ] Days 17–21: End-to-end canvas integration, Docker orchestration, and 20-day streak audit.
- [ ] Day 22: Grand integration merge into `main`, `v1.0.0` tag, and live deployment.
