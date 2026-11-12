# NexusFlow: Visual IoT Telemetry & Rule Engine
## Engineering Task Sheet: Kuldeep Behera (`dev-kuldeep`)

> **Assigned Engineer:** Kuldeep Behera  
> **Role:** Time-Series & Database Engineer (Persistence Pod)  
> **Dedicated Branch:** `dev-kuldeep`  
> **Repository:** [NexusFlow-Visual-IoT-Telemetry-Rule-Engine](https://github.com/mujtabashaikh2812-stack/NexusFlow-Visual-IoT-Telemetry-Rule-Engine)  
> **Evaluation Period:** 10 November 2026 – 10 December 2026 (22 Sprint Days)

---

### 🎯 Primary Scope of Work
You own the **high-speed persistence, Time-Series storage engine, and telemetry analytics** of NexusFlow:
1. Native **MongoDB 5.0+ Time-Series Collections** (`timeseries: { timeField: 'timestamp', metaField: 'metadata', granularity: 'seconds' }`) optimized for append-only sensor writes.
2. High-throughput database write engine capable of persisting high-frequency sensor telemetry with minimal storage footprint.
3. The **5,000 writes/sec Ingestion Benchmark Suite**: Stress-testing MongoDB write throughput and proving zero packet loss for the Mid-Project Review.
4. Rule Execution Audit Trail: Schema and persistence layer recording when rules are evaluated, triggered, and dispatched.
5. Historical aggregation pipelines: Moving averages, min/max peaks, anomaly counters, and device fleet summary queries.
6. Resilient In-Memory Fallback: Guaranteeing that all tests and database queries run seamlessly in CI/offline environments using in-memory mock stores.

---

### 📅 Day-by-Day Sprint Breakdown (Days 1 – 22)

#### 🔹 Week 1: Native MongoDB Time-Series Setup (Days 1 – 5)
- **Day 1 (Nov 10/11)**: Database Connection Module & In-Memory Fallback
  - *Files*: `src/database/dbConnection.js`, `src/database/inMemoryMock.js`
  - *Tasks*: Resilient MongoDB connection manager with auto-reconnect, exponential backoff, and zero-crash standalone fallback.
- **Day 2 (Nov 12)**: MongoDB 5.0+ Time-Series Collection Schema
  - *Files*: `src/database/models/TelemetryPoint.js`
  - *Tasks*: Define native Mongoose Time-Series schema (`timeField: 'timestamp'`, `metaField: 'metadata'`, `granularity: 'seconds'`). Metadata holds `{ deviceId, sensorType, location, model }`.
- **Day 3 (Nov 13)**: Compound Indexes on Metadata & Timestamp
  - *Files*: `src/database/indexes/timeSeriesIndexes.js`, `tests/timeSeriesIndexes.test.js`
  - *Tasks*: Build compound indexes: `{ 'metadata.deviceId': 1, timestamp: -1 }` and `{ 'metadata.sensorType': 1, timestamp: -1 }`.
- **Day 4 (Nov 14)**: Fast Batch Ingestion Writer
  - *Files*: `src/database/services/batchWriter.js`, `tests/batchWriter.test.js`
  - *Tasks*: Build high-throughput writer using MongoDB `bulkWrite({ insertOne: ... }, { ordered: false })` to maximize write IOPS.
- **Day 5 (Nov 15)**: Time-Series TTL Expiry Policy (Data Retention)
  - *Files*: `src/database/services/retentionPolicy.js`
  - *Tasks*: Configure automated bucket pruning (e.g., 30-day auto-expiry `expireAfterSeconds: 2592000`) to manage storage growth.

---

#### 🔹 Week 2: High-Speed Stress Testing & Ingestion Audit (Days 6 – 10)
- **Day 6 (Nov 16)**: Stress-Testing Ingestion Benchmark Harness
  - *Files*: `src/benchmarks/ingestionStressTest.js`
  - *Tasks*: Build concurrent multi-worker benchmark script simulating 100 virtual devices emitting telemetry simultaneously.
- **Day 7 (Nov 17)**: High-Throughput Write Optimization
  - *Files*: `src/database/services/writeOptimizer.js`
  - *Tasks*: Tune write concern (`w: 1`, `journal: false` for high-throughput buffering) and verify write efficiency.
- **Day 8 (Nov 18)**: Time-Series Bucket Compression Ratio Analyzer
  - *Files*: `src/benchmarks/compressionAudit.js`
  - *Tasks*: Calculate MongoDB column compression efficiency (bytes per reading vs raw JSON storage size).
- **Day 9 (Nov 19)**: Rule Definition Persistence Schema
  - *Files*: `src/database/models/RuleDefinition.js`, `tests/ruleModel.test.js`
  - *Tasks*: Create schema for saving visual React Flow graphs (`ruleId`, `name`, `nodes`, `edges`, `version`, `isActive`).
- **Day 10 (Nov 20)**: Device Registry & Metadata Catalog
  - *Files*: `src/database/models/Device.js`, `tests/deviceModel.test.js`
  - *Tasks*: Device asset catalog schema (`deviceId`, `name`, `sensors`, `firmwareVersion`, `status`, `lastSeenAt`).

---

#### 🔹 Mid-Project Review: Day 11 (Nov 21)
- **Day 11 (Nov 21)**: 5,000 Writes/Sec Ingestion Audit
  - *Tasks*: Execute and record the formal Mid-Project Ingestion Audit scorecard demonstrating **5,000+ writes/second** with zero data corruption and sub-10ms write latency.

---

#### 🔹 Week 3: Rule Audit Logging & Historical Queries (Days 12 – 16)
- **Day 12 (Nov 22)**: Rule Execution Audit Trail Schema
  - *Files*: `src/database/models/RuleAuditLog.js`
  - *Tasks*: Time-stamped schema logging rule triggers (`ruleId`, `deviceId`, `triggerValue`, `threshold`, `actionDispatched`, `latencyMs`).
- **Day 13 (Nov 23)**: High-Speed Query Service for Dashboard
  - *Files*: `src/database/services/queryService.js`, `tests/queryService.test.js`
  - *Tasks*: Fast range queries for live charts (`getRecentReadings(deviceId, sensorType, minutes = 5)`).
- **Day 14 (Nov 24)**: Aggregation Pipeline: Rolling Downsampling
  - *Files*: `src/database/aggregations/downsampling.js`
  - *Tasks*: Build MongoDB aggregation pipeline using `$bucketAuto` and `$dateTrunc` to aggregate raw 1-second data into 1-minute and 1-hour candles.
- **Day 15 (Nov 25)**: Anomaly & Threshold Violation Counters
  - *Files*: `src/database/aggregations/anomalyStats.js`
  - *Tasks*: Aggregation pipeline calculating daily breach frequencies, peak temperatures, and most volatile devices.
- **Day 16 (Nov 26)**: Historical Query Caching Layer
  - *Files*: `src/database/services/queryCache.js`
  - *Tasks*: In-memory LRU cache (5-second TTL) for repeated dashboard overview queries to reduce database disk IOPS.

---

#### 🔹 Week 4: Multi-Device Analytics, Docker & Release (Days 17 – 22)
- **Day 17 (Nov 27)**: Outbound Alert History & Cooldown Tracker
  - *Files*: `src/database/services/alertHistory.js`
  - *Tasks*: Persistent state store to enforce alert cooldown intervals (e.g., prevent duplicate SMS alerts within 5 minutes).
- **Day 18 (Nov 28)**: Database Health & Telemetry Exporter
  - *Files*: `src/database/services/dbHealthCheck.js`
  - *Tasks*: Health endpoint `/api/health/database` reporting active connections, collection document counts, and average write latency.
- **Day 19 (Nov 29)**: Seed Scripts & Synthetic Fleet Data
  - *Files*: `scripts/seedFleet.js`, `scripts/seedRules.js`
  - *Tasks*: CLI seed scripts to populate fresh development environments with 20 realistic devices and 5 preset industrial rules.
- **Day 20 (Nov 30)**: Time-Series Sharding & Replica Set Blueprint
  - *Files*: `docker/mongo-replica-set.yml`, `docs/DATABASE_SCALING.md`
  - *Tasks*: Document architecture for scaling MongoDB Time-Series to multi-node clusters and high availability.
- **Day 21 (Dec 01)**: Comprehensive Database Test Suite
  - *Files*: `tests/databaseSuite.test.js`
  - *Tasks*: Full test coverage verifying time-series creation, batch writes, TTL expiration, and audit trail retrieval.
- **Day 22 (Dec 02)**: Final Branch Integration & Production Certification
  - *Tasks*: Merge `dev-kuldeep` into `main` with Lead Mujtaba, verify zero schema conflicts, and certify database production readiness.

---

### 💻 Daily Git Workflow Instructions

```bash
# 1. Start your day on your branch
git checkout dev-kuldeep
git pull origin dev-kuldeep

# 2. Write your code and tests for the day's assigned tasks
# 3. Stage and commit with descriptive Conventional Commit messages (>50 characters)
git add .
git commit -m "feat(database): implement native MongoDB Time-Series TelemetryPoint schema"

# 4. Push daily to keep your 20-day streak active
git push origin dev-kuldeep
```
