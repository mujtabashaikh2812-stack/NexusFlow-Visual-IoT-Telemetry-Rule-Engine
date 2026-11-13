'use strict';

const { Server } = require('socket.io');
const config = require('../config/serverConfig');
const { defaultConnectionRegistry } = require('../core/connectionRegistry');

let ioInstance = null;

function initSocketServer(httpServer, options = {}) {
  const registry = options.connectionRegistry || defaultConnectionRegistry;

  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || config.isDevelopment() || config.clientOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error(`Origin ${origin} not permitted by NexusFlow CORS policy`));
      },
      credentials: true,
    },
    pingInterval: config.wsPingIntervalMs,
    pingTimeout: config.wsPingTimeoutMs,
  });

  io.on('connection', (socket) => {
    // 1. Dashboard Operator Join
    socket.on('client:join', (payload = {}) => {
      const client = registry.registerClient(socket.id, payload);
      socket.join('operators');
      socket.emit('client:joined', {
        success: true,
        client,
        stats: registry.getStats(),
      });
      io.to('operators').emit('stats:updated', registry.getStats());
    });

    // 2. IoT Hardware Device Announcement
    socket.on('device:announce', (payload = {}) => {
      if (!payload.deviceId) {
        socket.emit('device:error', { message: 'deviceId is required for announcement' });
        return;
      }
      const device = registry.registerDevice(socket.id, payload);
      socket.join('devices');
      socket.emit('device:announced', { success: true, device });
      io.to('operators').emit('device:connected', device);
      io.to('operators').emit('stats:updated', registry.getStats());
    });

    // 3. IoT Device Heartbeat
    socket.on('device:heartbeat', () => {
      const updated = registry.updateHeartbeat(socket.id);
      socket.emit('device:heartbeat_ack', { success: updated, timestamp: Date.now() });
    });

    // 4. Ingest Real-Time Telemetry Event from WebSocket Client / Device
    socket.on('telemetry:publish', (data = {}) => {
      if (!data.deviceId || typeof data.value === 'undefined') {
        socket.emit('telemetry:error', { message: 'Invalid telemetry payload: deviceId and value are required' });
        return;
      }

      const reading = {
        deviceId: String(data.deviceId),
        sensorType: data.sensorType || 'generic',
        value: Number(data.value),
        unit: data.unit || '',
        timestamp: data.timestamp || new Date().toISOString(),
        quality: data.quality || 'good',
      };

      // Broadcast to dashboard operators
      io.to('operators').emit('telemetry:stream', reading);
      socket.emit('telemetry:ack', { success: true, timestamp: Date.now() });
    });

    // 5. Client Subscribes to Rule Trigger Alerts
    socket.on('rule:subscribe', (ruleId) => {
      if (ruleId) {
        socket.join(`rule:${ruleId}`);
      }
      socket.join('alerts:all');
      socket.emit('rule:subscribed', { ruleId: ruleId || 'all' });
    });

    // 6. Graceful Disconnection
    socket.on('disconnect', (reason) => {
      const result = registry.unregister(socket.id);
      if (result && result.deviceRemoved) {
        io.to('operators').emit('device:disconnected', {
          deviceId: result.deviceId,
          reason,
        });
      }
      io.to('operators').emit('stats:updated', registry.getStats());
    });
  });

  ioInstance = io;
  return io;
}

function getIoInstance() {
  return ioInstance;
}

function broadcastTelemetry(reading) {
  if (ioInstance) {
    ioInstance.to('operators').emit('telemetry:stream', reading);
  }
}

function broadcastAlert(alertData) {
  if (ioInstance) {
    if (alertData && alertData.ruleId) {
      ioInstance.to(`rule:${alertData.ruleId}`).emit('rule:triggered', alertData);
    }
    ioInstance.to('alerts:all').emit('rule:triggered', alertData);
  }
}

module.exports = {
  initSocketServer,
  getIoInstance,
  broadcastTelemetry,
  broadcastAlert,
};
