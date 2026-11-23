import assert from "node:assert/strict";
import test from "node:test";
import {
  createSocketService,
  TELEMETRY_CHANNELS,
} from "./socketService.js";

class FakeWebSocket {
  static instances = [];
  static CONNECTING = 0;
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    this.sentMessages = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(listener);
  }

  send(message) {
    this.sentMessages.push(message);
  }

  close() {
    this.readyState = 3;
    this.dispatch("close", {});
  }

  dispatch(type, event) {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  receive(message) {
    this.dispatch("message", { data: message });
  }
}

test("subscribes to required channels and dispatches channel messages", () => {
  FakeWebSocket.instances = [];
  const service = createSocketService("ws://localhost:3000", FakeWebSocket);
  const received = [];
  const statuses = [];
  service.subscribe("telemetry:stream", (payload) => received.push(payload));
  service.subscribeStatus((status) => statuses.push(status));

  service.connect();
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, "ws://localhost:3000");

  socket.open();
  assert.deepEqual(JSON.parse(socket.sentMessages[0]), {
    type: "subscribe",
    channels: TELEMETRY_CHANNELS,
  });
  socket.receive(
    JSON.stringify({
      event: "telemetry:stream",
      data: { sensorType: "temperature", value: 83 },
    }),
  );

  assert.deepEqual(received, [
    { sensorType: "temperature", value: 83 },
  ]);
  assert.deepEqual(statuses, ["disconnected", "connecting", "connected"]);

  service.disconnect();
  assert.equal(statuses.at(-1), "disconnected");
});

test("reports invalid server messages and removes unsubscribed listeners", () => {
  FakeWebSocket.instances = [];
  const service = createSocketService("ws://localhost:3000", FakeWebSocket);
  const received = [];
  const errors = [];
  const unsubscribe = service.subscribe("rule:triggered", (payload) =>
    received.push(payload),
  );
  service.subscribeErrors((error) => errors.push(error.message));

  service.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  unsubscribe();
  socket.receive(
    JSON.stringify({ channel: "rule:triggered", payload: { ruleId: "overheat" } }),
  );
  socket.receive("not json");

  assert.deepEqual(received, []);
  assert.deepEqual(errors, [
    "Received an invalid JSON message from the WebSocket server.",
  ]);
  service.disconnect();
});
