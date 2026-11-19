'use strict';

const http = require('http');
const express = require('express');
const cors = require('cors');
const config = require('./config/serverConfig');
const { initSocketServer, broadcastTelemetry, broadcastAlert } = require('./sockets/socketManager');
const { defaultConnectionRegistry } = require('./core/connectionRegistry');
const { defaultRuleParser, RuleParserError } = require('./core/ruleParser');
const { defaultRuleEvaluator } = require('./core/ruleEvaluator');
const { defaultRuleStore } = require('./core/ruleStore');
const { validateRulePayload } = require('./middleware/ruleValidationMiddleware');

const app = express();
const server = http.createServer(app);

// Initialize Socket.io real-time engine
const io = initSocketServer(server);

// Enable Cross-Origin Resource Sharing (CORS) with dynamic origin validation
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (config.isDevelopment() || config.clientOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not permitted by NexusFlow CORS policy`));
    },
    credentials: true,
  })
);

// Standard Body Parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health Check Gateway (Comprehensive Subsystem Status)
const healthHandler = (req, res) => {
  const stats = defaultConnectionRegistry.getStats();
  const mem = process.memoryUsage();

  res.status(200).json({
    status: 'healthy',
    service: 'NexusFlow IoT Telemetry & Rule Engine Gateway',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    subsystems: {
      httpServer: 'online',
      socketEngine: io ? 'online' : 'degraded',
      connectionRegistry: 'online',
    },
    telemetryStats: {
      activeOperators: stats.activeClients,
      connectedDevices: stats.activeDevices,
      totalSessions: stats.totalConnections,
    },
    systemMetrics: {
      heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      rssMb: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
      nodeVersion: process.version,
    },
  });
};

app.get('/api/health', healthHandler);
app.get('/healthz', healthHandler);

// Public Stats Endpoint for Dashboard
app.get('/api/system/stats', (req, res) => {
  res.status(200).json(defaultConnectionRegistry.getStats());
});

// Device Catalog Endpoint
app.get('/api/devices', (req, res) => {
  res.status(200).json({
    devices: defaultConnectionRegistry.getAllDevices(),
    count: defaultConnectionRegistry.devices.size,
  });
});

// Telemetry Ingestion Gateway (HTTP POST fallback for non-WebSocket sensors)
app.post('/api/telemetry/ingest', (req, res) => {
  const payload = req.body;
  if (!payload || !payload.deviceId || typeof payload.value === 'undefined') {
    return res.status(400).json({
      error: 'BAD_REQUEST',
      message: 'Invalid telemetry payload: deviceId and value are required',
    });
  }

  const reading = {
    deviceId: String(payload.deviceId),
    sensorType: payload.sensorType || 'generic',
    value: Number(payload.value),
    unit: payload.unit || '',
    timestamp: payload.timestamp || new Date().toISOString(),
    quality: payload.quality || 'good',
  };

  // Broadcast to connected dashboard clients
  broadcastTelemetry(reading);

  // Evaluate reading across all active reactive rule pipelines
  const evalResult = defaultRuleEvaluator.evaluate(reading);
  if (evalResult.triggeredAlerts && evalResult.triggeredAlerts.length > 0) {
    for (const alert of evalResult.triggeredAlerts) {
      broadcastAlert(alert);
    }
  }

  return res.status(202).json({
    status: 'accepted',
    message: 'Telemetry reading queued and broadcasted',
    reading,
    evaluation: {
      matchedRules: evalResult.matchedRules,
      alertsTriggered: evalResult.triggeredAlerts.length,
      alerts: evalResult.triggeredAlerts,
    },
  });
});

// Rule Graph Pre-Flight Validation Endpoint
app.post('/api/rules/validate', (req, res) => {
  try {
    const ast = defaultRuleParser.parse(req.body);
    return res.status(200).json({
      valid: true,
      metadata: ast.metadata,
      executionPlan: ast.executionPlan,
    });
  } catch (err) {
    if (err instanceof RuleParserError) {
      return res.status(200).json({
        valid: false,
        errorCode: err.code,
        errorMessage: err.message,
        details: err.details,
      });
    }
    return res.status(400).json({
      valid: false,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: err.message,
    });
  }
});

// Rule AST Compilation Endpoint
app.post('/api/rules/compile', (req, res) => {
  try {
    const ast = defaultRuleParser.parse(req.body);
    return res.status(200).json({
      status: 'success',
      ast,
    });
  } catch (err) {
    if (err instanceof RuleParserError) {
      return res.status(400).json({
        error: err.code,
        message: err.message,
        details: err.details,
      });
    }
    return res.status(500).json({
      error: 'COMPILATION_ERROR',
      message: err.message,
    });
  }
});

// List Active Deployed Rules & Diagnostics
app.get('/api/rules/active', (req, res) => {
  const activeRules = defaultRuleEvaluator.getActiveRules();
  res.status(200).json({
    count: activeRules.length,
    rules: activeRules,
  });
});

// Deploy Rule to Live Execution Engine & Persist to Storage
app.post('/api/rules/deploy', validateRulePayload(), (req, res) => {
  try {
    const ast = req.compiledAst;
    const deployment = defaultRuleEvaluator.registerRule(ast);
    const saveMeta = defaultRuleStore.saveRule(ast);

    return res.status(201).json({
      status: 'deployed',
      ruleId: deployment.ruleId,
      nodeCount: deployment.nodeCount,
      executionPlan: deployment.executionPlan,
      persisted: true,
      checksum: saveMeta.checksum,
    });
  } catch (err) {
    if (err instanceof RuleParserError) {
      return res.status(400).json({
        error: err.code,
        message: err.message,
        details: err.details,
      });
    }
    return res.status(400).json({
      error: 'DEPLOYMENT_FAILED',
      message: err.message,
    });
  }
});

// Dynamic Hot-Reload Endpoint (Atomically updates rule pipeline, preserves rolling buffers)
app.put('/api/rules/:ruleId', validateRulePayload(), (req, res) => {
  try {
    const ast = req.compiledAst;
    ast.ruleId = req.params.ruleId; // ensure ID matches URL param

    const preserveState = req.query.preserveState !== 'false';
    const reloadResult = defaultRuleEvaluator.hotReloadRule(ast, { preserveState });
    const saveMeta = defaultRuleStore.saveRule(ast);

    // Broadcast reload notification to connected dashboard operators via WebSocket
    if (io) {
      io.to('operators').emit('rule:reloaded', {
        ruleId: ast.ruleId,
        reloadedAt: new Date().toISOString(),
        diff: reloadResult.diff,
      });
    }

    return res.status(200).json({
      status: 'reloaded',
      ruleId: reloadResult.ruleId,
      isNew: reloadResult.isNew,
      diff: reloadResult.diff,
      preservedBufferCount: reloadResult.preservedBufferCount,
      reloadsCount: reloadResult.reloadsCount,
      persisted: true,
      checksum: saveMeta.checksum,
    });
  } catch (err) {
    return res.status(400).json({
      error: 'HOT_RELOAD_FAILED',
      message: err.message,
    });
  }
});

// Pre-flight Rule Diff Inspection Endpoint
app.post('/api/rules/:ruleId/diff', validateRulePayload(), (req, res) => {
  const ast = req.compiledAst;
  ast.ruleId = req.params.ruleId;

  const diff = defaultRuleEvaluator.diffRule(ast);
  if (!diff) {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: `Active rule "${req.params.ruleId}" not found for diff comparison`,
    });
  }

  return res.status(200).json({
    ruleId: ast.ruleId,
    diff,
  });
});

// Export Rule Snapshot Bundle
app.get('/api/rules/export', (req, res) => {
  const snapshot = defaultRuleStore.exportSnapshot();
  res.status(200).json(snapshot);
});

// Import Rule Snapshot Bundle
app.post('/api/rules/import', (req, res) => {
  try {
    const importStats = defaultRuleStore.importSnapshot(req.body);
    for (const item of req.body.rules || []) {
      const ast = item.ast || item;
      if (ast && ast.ruleId && Array.isArray(ast.executionPlan)) {
        defaultRuleEvaluator.registerRule(ast);
      }
    }
    return res.status(200).json({
      status: 'imported',
      ...importStats,
      activeRulesCount: defaultRuleEvaluator.getActiveRules().length,
    });
  } catch (err) {
    return res.status(400).json({
      error: 'IMPORT_FAILED',
      message: err.message,
    });
  }
});

// Storage Diagnostics Endpoint
app.get('/api/rules/storage/stats', (req, res) => {
  res.status(200).json(defaultRuleStore.getStats());
});

// Get Individual Rule Metrics
app.get('/api/rules/:ruleId', (req, res) => {
  const rule = defaultRuleEvaluator.getRule(req.params.ruleId);
  if (!rule) {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: `Rule "${req.params.ruleId}" is not deployed in active evaluator`,
    });
  }
  return res.status(200).json(rule);
});

// Undeploy Rule from Active Evaluation and Disk Storage
app.delete('/api/rules/:ruleId', (req, res) => {
  const removedFromEvaluator = defaultRuleEvaluator.unregisterRule(req.params.ruleId);
  const removedFromStore = defaultRuleStore.deleteRule(req.params.ruleId);

  if (!removedFromEvaluator && !removedFromStore) {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: `Rule "${req.params.ruleId}" not found or already inactive`,
    });
  }
  return res.status(200).json({
    status: 'undeployed',
    ruleId: req.params.ruleId,
    deletedFromStorage: removedFromStore,
  });
});

// 404 Route Handler
app.use((req, res) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: `Route ${req.method} ${req.url} does not exist on NexusFlow server`,
  });
});

// Global Error Boundary Middleware
app.use((err, req, res, _next) => {
  console.error('[NexusFlow Server Error]:', err.message);
  res.status(err.status || 500).json({
    error: 'INTERNAL_SERVER_ERROR',
    message: config.isProduction() ? 'Internal Server Error' : err.message,
  });
});

function bootstrapRulesFromStore() {
  try {
    const persisted = defaultRuleStore.loadAllRules();
    let loaded = 0;
    for (const record of persisted) {
      if (record && record.ast) {
        defaultRuleEvaluator.registerRule(record.ast);
        loaded++;
      }
    }
    if (loaded > 0) {
      console.log(`[NexusFlow] Restored ${loaded} persisted rule(s) from storage into live engine`);
    }
    return loaded;
  } catch (err) {
    console.error('[NexusFlow] Rule bootstrap error:', err.message);
    return 0;
  }
}

function startServer(port = config.port) {
  return new Promise((resolve) => {
    bootstrapRulesFromStore();
    server.listen(port, () => {
      console.log(`[NexusFlow] Core Server & WebSocket Engine listening on port ${port} (${config.nodeEnv})`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  server,
  io,
  bootstrapRulesFromStore,
  startServer,
};
