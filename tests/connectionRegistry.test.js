'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ConnectionRegistry } = require('../src/core/connectionRegistry');

test('ConnectionRegistry: registers client session with metadata', () => {
  const registry = new ConnectionRegistry();
  const client = registry.registerClient('sock_123', {
    role: 'admin',
    username: 'Mujtaba',
  });

  assert.equal(client.socketId, 'sock_123');
  assert.equal(client.role, 'admin');
  assert.equal(client.username, 'Mujtaba');
  assert.equal(typeof client.connectedAt, 'string');
  assert.equal(registry.clients.size, 1);
});

test('ConnectionRegistry: registers IoT device and sets online status', () => {
  const registry = new ConnectionRegistry();
  const device = registry.registerDevice('sock_device_1', {
    deviceId: 'turbine-omega',
    deviceType: 'turbine',
    sensorTypes: ['temperature', 'vibration'],
    location: 'Sector 4',
  });

  assert.equal(device.deviceId, 'turbine-omega');
  assert.equal(device.deviceType, 'turbine');
  assert.equal(device.sensorTypes.length, 2);
  assert.equal(device.status, 'online');
  assert.equal(registry.devices.size, 1);
  assert.equal(registry.getDevice('turbine-omega').socketId, 'sock_device_1');
});

test('ConnectionRegistry: updateHeartbeat refreshes lastHeartbeat timestamp', () => {
  const registry = new ConnectionRegistry();
  registry.registerDevice('sock_device_2', { deviceId: 'boiler-01' });

  const initialHeartbeat = registry.getDevice('boiler-01').lastHeartbeat;
  const updated = registry.updateHeartbeat('sock_device_2');

  assert.equal(updated, true);
  assert.equal(typeof registry.getDevice('boiler-01').lastHeartbeat, 'string');
});

test('ConnectionRegistry: unregister cleanly removes both client and device mappings', () => {
  const registry = new ConnectionRegistry();
  registry.registerClient('sock_op_1');
  registry.registerDevice('sock_dev_1', { deviceId: 'sensor-99' });

  assert.equal(registry.clients.size, 1);
  assert.equal(registry.devices.size, 1);

  const clientUnreg = registry.unregister('sock_op_1');
  assert.equal(clientUnreg.clientRemoved, true);
  assert.equal(registry.clients.size, 0);

  const deviceUnreg = registry.unregister('sock_dev_1');
  assert.equal(deviceUnreg.deviceRemoved, true);
  assert.equal(deviceUnreg.deviceId, 'sensor-99');
  assert.equal(registry.devices.size, 0);
  assert.equal(registry.socketToDevice.size, 0);
});

test('ConnectionRegistry: getStats compiles accurate aggregate counts', () => {
  const registry = new ConnectionRegistry();
  registry.registerClient('c1');
  registry.registerClient('c2');
  registry.registerDevice('d1', { deviceId: 'sensor-a' });

  const stats = registry.getStats();
  assert.equal(stats.activeClients, 2);
  assert.equal(stats.activeDevices, 1);
  assert.equal(stats.totalConnections, 3);
  assert.equal(typeof stats.timestamp, 'string');
});
