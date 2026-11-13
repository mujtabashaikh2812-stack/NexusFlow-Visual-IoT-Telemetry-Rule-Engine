'use strict';

/**
 * NexusFlow Connection Registry
 * Manages active WebSocket sessions for dashboard operators and connected IoT devices.
 */

class ConnectionRegistry {
  constructor() {
    this.clients = new Map(); // socketId -> clientMetadata
    this.devices = new Map(); // deviceId -> { socketId, metadata, registeredAt, lastHeartbeat }
    this.socketToDevice = new Map(); // socketId -> deviceId
  }

  registerClient(socketId, metadata = {}) {
    if (!socketId) return null;
    const clientRecord = {
      socketId,
      role: metadata.role || 'operator',
      username: metadata.username || `Operator-${socketId.slice(0, 4)}`,
      connectedAt: new Date().toISOString(),
      userAgent: metadata.userAgent || 'unknown',
    };
    this.clients.set(socketId, clientRecord);
    return clientRecord;
  }

  registerDevice(socketId, metadata = {}) {
    if (!socketId || !metadata.deviceId) return null;
    const deviceId = String(metadata.deviceId).trim();
    const now = new Date().toISOString();

    const deviceRecord = {
      deviceId,
      socketId,
      deviceType: metadata.deviceType || 'generic-sensor',
      sensorTypes: Array.isArray(metadata.sensorTypes) ? metadata.sensorTypes : ['telemetry'],
      location: metadata.location || 'Factory Floor 1',
      firmwareVersion: metadata.firmwareVersion || '1.0.0',
      status: 'online',
      connectedAt: now,
      lastHeartbeat: now,
    };

    this.devices.set(deviceId, deviceRecord);
    this.socketToDevice.set(socketId, deviceId);
    return deviceRecord;
  }

  updateHeartbeat(socketId) {
    const deviceId = this.socketToDevice.get(socketId);
    if (deviceId && this.devices.has(deviceId)) {
      const record = this.devices.get(deviceId);
      record.lastHeartbeat = new Date().toISOString();
      return true;
    }
    return false;
  }

  unregister(socketId) {
    if (!socketId) return null;
    const clientRemoved = this.clients.delete(socketId);

    const deviceId = this.socketToDevice.get(socketId);
    let deviceRemoved = false;
    if (deviceId) {
      deviceRemoved = this.devices.delete(deviceId);
      this.socketToDevice.delete(socketId);
    }

    return {
      socketId,
      clientRemoved,
      deviceRemoved,
      deviceId: deviceId || null,
    };
  }

  getClient(socketId) {
    return this.clients.get(socketId) || null;
  }

  getDevice(deviceId) {
    return this.devices.get(deviceId) || null;
  }

  getAllClients() {
    return Array.from(this.clients.values());
  }

  getAllDevices() {
    return Array.from(this.devices.values());
  }

  getStats() {
    return {
      activeClients: this.clients.size,
      activeDevices: this.devices.size,
      totalConnections: this.clients.size + this.socketToDevice.size,
      timestamp: new Date().toISOString(),
    };
  }

  clear() {
    this.clients.clear();
    this.devices.clear();
    this.socketToDevice.clear();
  }
}

const defaultConnectionRegistry = new ConnectionRegistry();

module.exports = {
  ConnectionRegistry,
  defaultConnectionRegistry,
};
