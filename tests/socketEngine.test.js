'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { io: ClientIO } = require('socket.io-client');
const { app, server } = require('../src/server');
const { defaultConnectionRegistry } = require('../src/core/connectionRegistry');

let wsPort = 49200 + Math.floor(Math.random() * 500);
let serverInstance = null;

test.before(async () => {
  defaultConnectionRegistry.clear();
  await new Promise((resolve) => {
    serverInstance = server.listen(wsPort, () => resolve());
  });
});

test.after(async () => {
  defaultConnectionRegistry.clear();
  if (serverInstance) {
    await new Promise((resolve) => serverInstance.close(resolve));
  }
});

function createClientSocket() {
  return ClientIO(`http://127.0.0.1:${wsPort}`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
}

test('SocketEngine: operator client joins and receives client:joined confirmation', async () => {
  const socket = createClientSocket();

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timed out')), 4000);

    socket.on('connect', () => {
      socket.emit('client:join', { username: 'Lead-Mujtaba', role: 'admin' });
    });

    socket.on('client:joined', (payload) => {
      clearTimeout(timeout);
      assert.equal(payload.success, true);
      assert.equal(payload.client.username, 'Lead-Mujtaba');
      assert.equal(payload.client.role, 'admin');
      assert.equal(typeof payload.stats.activeClients, 'number');
      socket.disconnect();
      resolve();
    });
  });
});

test('SocketEngine: IoT device announces presence and receives device:announced', async () => {
  const socket = createClientSocket();

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Device announcement timed out')), 4000);

    socket.on('connect', () => {
      socket.emit('device:announce', {
        deviceId: 'vibration-probe-01',
        deviceType: 'vibration-sensor',
        sensorTypes: ['vibration_velocity', 'peak_acceleration'],
        location: 'Turbine Bay B',
      });
    });

    socket.on('device:announced', (payload) => {
      clearTimeout(timeout);
      assert.equal(payload.success, true);
      assert.equal(payload.device.deviceId, 'vibration-probe-01');
      assert.equal(payload.device.location, 'Turbine Bay B');
      socket.disconnect();
      resolve();
    });
  });
});

test('SocketEngine: telemetry:publish broadcasts telemetry:stream to operator room', async () => {
  const operatorSocket = createClientSocket();
  const deviceSocket = createClientSocket();

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Telemetry broadcast timed out')), 4000);

    let operatorConnected = false;
    let deviceConnected = false;

    operatorSocket.on('connect', () => {
      operatorSocket.emit('client:join', { username: 'Operator-Audit' });
    });

    operatorSocket.on('client:joined', () => {
      operatorConnected = true;
      if (deviceConnected) publishTelemetry();
    });

    deviceSocket.on('connect', () => {
      deviceSocket.emit('device:announce', { deviceId: 'pressure-transducer-04' });
    });

    deviceSocket.on('device:announced', () => {
      deviceConnected = true;
      if (operatorConnected) publishTelemetry();
    });

    function publishTelemetry() {
      deviceSocket.emit('telemetry:publish', {
        deviceId: 'pressure-transducer-04',
        sensorType: 'pressure',
        value: 142.8,
        unit: 'PSI',
      });
    }

    operatorSocket.on('telemetry:stream', (reading) => {
      clearTimeout(timeout);
      assert.equal(reading.deviceId, 'pressure-transducer-04');
      assert.equal(reading.sensorType, 'pressure');
      assert.equal(reading.value, 142.8);
      operatorSocket.disconnect();
      deviceSocket.disconnect();
      resolve();
    });
  });
});

test('SocketEngine: client subscribes to rules and receives rule:subscribed ack', async () => {
  const socket = createClientSocket();

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Rule subscription timed out')), 4000);

    socket.on('connect', () => {
      socket.emit('rule:subscribe', 'rule-turbine-overheat');
    });

    socket.on('rule:subscribed', (payload) => {
      clearTimeout(timeout);
      assert.equal(payload.ruleId, 'rule-turbine-overheat');
      socket.disconnect();
      resolve();
    });
  });
});
