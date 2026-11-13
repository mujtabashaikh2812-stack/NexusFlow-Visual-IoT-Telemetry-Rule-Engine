'use strict';

/**
 * NexusFlow Server Configuration Module
 * Loads environment variables with resilient fallback defaults.
 */

try {
  require('dotenv').config();
} catch (_) {
  // Graceful fallback if dotenv is absent
}

function parseClientOrigins(originString) {
  if (!originString || typeof originString !== 'string') {
    return [
      'http://localhost:5173',
      'http://localhost:3000',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:3000',
    ];
  }
  return originString
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

const config = {
  port: parseInt(process.env.PORT, 10) || 4000,
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  clientOrigins: parseClientOrigins(process.env.CLIENT_ORIGIN),
  maxTelemetryBuffer: parseInt(process.env.MAX_TELEMETRY_BUFFER, 10) || 10000,
  wsPingIntervalMs: parseInt(process.env.WS_PING_INTERVAL_MS, 10) || 25000,
  wsPingTimeoutMs: parseInt(process.env.WS_PING_TIMEOUT_MS, 10) || 20000,

  isProduction() {
    return this.nodeEnv === 'production';
  },

  isDevelopment() {
    return this.nodeEnv === 'development';
  },
};

module.exports = config;
