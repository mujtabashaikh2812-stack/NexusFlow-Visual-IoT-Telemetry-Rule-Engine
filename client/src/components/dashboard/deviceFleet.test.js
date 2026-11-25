import assert from "node:assert/strict";
import test from "node:test";
import { getFleetDeviceUpdates, summarizeFleet } from "./deviceFleet.js";

test("normalizes device metadata without inventing missing fleet values", () => {
  const devices = getFleetDeviceUpdates({
    readings: [
      {
        deviceId: "pump-01",
        data: { status: "connected", batteryLevel: "82", rssi: -61 },
      },
      { deviceId: "pump-02", online: false, batteryLevel: 130 },
      { sensorType: "temperature", value: 42 },
    ],
  });

  assert.deepEqual(devices, [
    {
      id: "pump-01",
      name: "pump-01",
      status: "online",
      battery: 82,
      signal: -61,
      signalUnit: "dBm",
    },
    {
      id: "pump-02",
      name: "pump-02",
      status: "offline",
      battery: null,
      signal: null,
      signalUnit: null,
    },
  ]);
});

test("summarizes only reported values and does not average different signal units", () => {
  const devices = [
    { status: "online", battery: 80, signal: -60, signalUnit: "dBm" },
    { status: "offline", battery: null, signal: 75, signalUnit: "%" },
    { status: null, battery: 60, signal: null, signalUnit: null },
  ];

  assert.deepEqual(summarizeFleet(devices), {
    totalCount: 3,
    onlineCount: 1,
    offlineCount: 1,
    unknownStatusCount: 1,
    averageBattery: 70,
    averageSignal: null,
    signalUnit: null,
  });
});
