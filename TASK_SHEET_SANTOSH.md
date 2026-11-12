# NexusFlow: Visual IoT Telemetry & Rule Engine
## Engineering Task Sheet: Santosh Bhujbal (`dev-santosh`)

> **Assigned Engineer:** Santosh Bhujbal  
> **Role:** Streaming & Ingestion Engineer (Backend Stream Pod)  
> **Dedicated Branch:** `dev-santosh`  
> **Repository:** [NexusFlow-Visual-IoT-Telemetry-Rule-Engine](https://github.com/mujtabashaikh2812-stack/NexusFlow-Visual-IoT-Telemetry-Rule-Engine)  
> **Evaluation Period:** 10 November 2026 – 10 December 2026 (22 Sprint Days)

---

### 🎯 Primary Scope of Work
You own the **real-time data ingestion and reactive streaming layer** of NexusFlow:
1. High-throughput Express endpoints (`POST /api/telemetry/ingest`) capable of receiving multi-sensor payloads.
2. High-speed synthetic mock hardware telemetry generator (simulating turbines, boilers, vibration monitors, and environmental sensors).
3. The **RxJS Stream Compiler**: A backend engine that takes a visual graph JSON definition from Akhila's canvas and translates connected nodes into reactive Observable data streams (`fromEvent`, `filter`, `map`, `bufferTime`, `debounceTime`).
4. Outbound action dispatchers: Webhook triggers and simulated SMS notifications when rule conditions evaluate to true.

---

### 📅 Day-by-Day Sprint Breakdown (Days 1 – 22)

#### 🔹 Week 1: High-Throughput Ingestion & Mock Hardware (Days 1 – 5)
- **Day 1 (Nov 10/11)**: Initialize Ingestion Router & Payload Validator
  - *Files*: `src/ingestion/telemetryRouter.js`, `src/ingestion/validator.js`
  - *Tasks*: Build Express router for `/api/telemetry/ingest` with strict schema validation (checks `deviceId`, `timestamp`, `sensorType`, `value`, `unit`).
- **Day 2 (Nov 12)**: Mock Hardware Sensor Simulator
  - *Files*: `src/simulator/hardwareSimulator.js`, `scripts/simulateSensors.js`
  - *Tasks*: Create multi-device telemetry generator emitting realistic continuous data streams (Turbine RPM, Core Temperature 40–110°C, Vibration 0–15mm/s).
- **Day 3 (Nov 13)**: Ingestion In-Memory Ingestion Buffer
  - *Files*: `src/ingestion/telemetryBuffer.js`, `tests/telemetryBuffer.test.js`
  - *Tasks*: Implement ring buffer queue to decouple incoming HTTP bursts from database write operations with batch flush capabilities.
- **Day 4 (Nov 14)**: WebSocket Telemetry Broadcast Relay
  - *Files*: `src/sockets/telemetryRelay.js`, `tests/telemetryRelay.test.js`
  - *Tasks*: Broadcast raw incoming sensor events to connected frontend clients on channel `telemetry:stream` with sub-15ms latency.
- **Day 5 (Nov 15)**: Multi-Sensor Batch Ingestion Support
  - *Files*: `src/ingestion/batchIngest.js`, `tests/batchIngest.test.js`
  - *Tasks*: Enable bulk array ingestion payload (`POST /api/telemetry/batch`) supporting up to 500 readings per single HTTP request.

---

#### 🔹 Week 2: RxJS Stream Compiler & Graph Parser (Days 6 – 10)
- **Day 6 (Nov 16)**: Graph JSON Parser & AST Validator
  - *Files*: `src/compiler/graphParser.js`, `tests/graphParser.test.js`
  - *Tasks*: Parse React Flow JSON definitions exported by Akhila's frontend. Validate node connectivity, cycles, and dangling edge references.
- **Day 7 (Nov 17)**: RxJS Node Factory: Sensor Data Sources
  - *Files*: `src/compiler/nodes/sourceNode.js`
  - *Tasks*: Build RxJS source observable node factory binding specific `deviceId` and `sensorType` streams to the rule execution pipeline.
- **Day 8 (Nov 18)**: RxJS Node Factory: Filter & Threshold Evaluators
  - *Files*: `src/compiler/nodes/filterNode.js`, `tests/filterNode.test.js`
  - *Tasks*: Implement comparison operators (`>`, `<`, `==`, `between`) wrapped in RxJS `filter()` operators.
- **Day 9 (Nov 19)**: RxJS Node Factory: Math & Moving Average Windows
  - *Files*: `src/compiler/nodes/mathNode.js`, `tests/mathNode.test.js`
  - *Tasks*: Implement mathematical transformers: rolling moving average window (`bufferCount`, `reduce`), rate of change, and unit converters (°C to °F).
- **Day 10 (Nov 20)**: RxJS Stream Pipeline Assembler
  - *Files*: `src/compiler/streamCompiler.js`, `tests/streamCompiler.test.js`
  - *Tasks*: Chain instantiated source, filter, and math nodes together using RxJS `.pipe()` into an executable reactive pipeline.

---

#### 🔹 Mid-Project Review: Day 11 (Nov 21)
- **Day 11 (Nov 21)**: Compilation & Serialization Integration Audit
  - *Tasks*: Collaborate with Akhila to verify that complex visual graphs serialized from the frontend canvas compile seamlessly into reactive streams without memory leaks.

---

#### 🔹 Week 3: In-Memory Live Execution & WebSocket Subscriptions (Days 12 – 16)
- **Day 12 (Nov 22)**: Dynamic Pipeline Execution Manager
  - *Files*: `src/engine/pipelineManager.js`, `tests/pipelineManager.test.js`
  - *Tasks*: Registry allowing dynamic startup, pause, update, and teardown of compiled rule streams in Node.js process memory.
- **Day 13 (Nov 23)**: Live Data Stream Binding to Compiled Rules
  - *Files*: `src/engine/liveRuleRunner.js`
  - *Tasks*: Pipe live telemetry from the ingestion buffer directly into active rule pipelines and measure per-event processing latency (<2ms).
- **Day 14 (Nov 24)**: State Duration Timers (Debounce / Time-Windowing)
  - *Files*: `src/compiler/nodes/timerNode.js`, `tests/timerNode.test.js`
  - *Tasks*: Implement duration condition ("If Temp > 80°C for at least 30 continuous seconds") using RxJS `debounceTime()` and `windowTime()`.
- **Day 15 (Nov 25)**: Per-Device Stream Partitioning
  - *Files*: `src/engine/streamPartition.js`
  - *Tasks*: Partition high-volume telemetry by device ID using RxJS `groupBy()` to prevent cross-device condition bleed.
- **Day 16 (Nov 26)**: Live Alert Event Emitter
  - *Files*: `src/engine/alertEmitter.js`, `tests/alertEmitter.test.js`
  - *Tasks*: When a rule condition evaluates to true, emit structured alert events (`rule:triggered`) over WebSockets to client subscribers.

---

#### 🔹 Week 4: Outbound Webhooks, Alerting & Polish (Days 17 – 22)
- **Day 17 (Nov 27)**: Webhook Dispatcher Engine
  - *Files*: `src/actions/webhookDispatcher.js`, `tests/webhookDispatcher.test.js`
  - *Tasks*: Implement asynchronous HTTP POST dispatcher with exponential backoff retry logic (3 attempts) for external system webhooks.
- **Day 18 (Nov 28)**: Mock SMS & Email Alert Notification Provider
  - *Files*: `src/actions/notificationService.js`, `tests/notificationService.test.js`
  - *Tasks*: Simulate SMS/email dispatching with rate-limiting cooldown to prevent alert flooding (max 1 alert per 5 minutes per rule).
- **Day 19 (Nov 29)**: Execution Latency & Anomaly Telemetry
  - *Files*: `src/telemetry/streamMetrics.js`
  - *Tasks*: Record per-rule execution throughput (events/sec), mean latency, and active pipeline memory footprints.
- **Day 20 (Nov 30)**: Edge Case Hardening & Error Boundaries
  - *Files*: `src/engine/ruleErrorHandler.js`
  - *Tasks*: Handle invalid sensor datatypes, NaN values, disconnected nodes, and null payloads gracefully without crashing the pipeline.
- **Day 21 (Dec 01)**: Comprehensive Ingestion Test Suite
  - *Files*: `tests/ingestionSuite.test.js`
  - *Tasks*: Verify 100% test pass rate across ingestion endpoints, buffer queues, stream compilation, and webhook dispatches.
- **Day 22 (Dec 02)**: Final Branch Merge & Production Verification
  - *Tasks*: Merge `dev-santosh` into `main` with Lead Mujtaba, verify zero conflicts, and certify production readiness.

---

### 💻 Daily Git Workflow Instructions

```bash
# 1. Start your day on your branch
git checkout dev-santosh
git pull origin dev-santosh

# 2. Write your code and tests for the day's assigned tasks
# 3. Stage and commit with descriptive Conventional Commit messages (>50 characters)
git add .
git commit -m "feat(ingestion): implement telemetryBuffer with ring queue and batch flush"

# 4. Push daily to keep your 20-day streak active
git push origin dev-santosh
```
