import assert from "node:assert/strict";
import test from "node:test";
import { getTelemetryPoints } from "./useTelemetryStream.js";

test("normalizes paired telemetry samples with ISO timestamps", () => {
  const latestValues = { temperature: null, vibration: null };
  const timestamp = Date.parse("2026-11-23T12:00:00Z");

  assert.deepEqual(
    getTelemetryPoints(
      {
        timestamp: "2026-11-23T12:00:00Z",
        temperature: "82.5",
        vibration: 3.2,
      },
      latestValues,
    ),
    [{ timestamp, temperature: 82.5, vibration: 3.2 }],
  );
  assert.deepEqual(latestValues, { temperature: 82.5, vibration: 3.2 });
});

test("combines individual sensor readings and converts second timestamps", () => {
  const latestValues = { temperature: null, vibration: null };

  assert.deepEqual(
    getTelemetryPoints(
      [
        { timestamp: 1_795_344_000, sensorType: "Temperature", value: 81 },
        { timestamp: 1_795_344_001, sensorType: "vibration", value: "2.7" },
      ],
      latestValues,
    ),
    [
      {
        timestamp: 1_795_344_001_000,
        temperature: 81,
        vibration: 2.7,
      },
    ],
  );
});

test("ignores unsupported and non-numeric sensor values", () => {
  const latestValues = { temperature: null, vibration: null };

  assert.deepEqual(
    getTelemetryPoints(
      [
        { sensorType: "humidity", value: 40 },
        { sensorType: "temperature", value: "not-a-number" },
      ],
      latestValues,
    ),
    [],
  );
});

test("tracks configured sensor values without adding them to chart samples", () => {
  const latestValues = { temperature: 81, vibration: 2.7 };

  assert.deepEqual(
    getTelemetryPoints(
      [
        { sensorType: "Pressure", value: "101.3" },
        { sensorType: "Flow rate", value: 12.5 },
      ],
      latestValues,
    ),
    [],
  );
  assert.deepEqual(latestValues, {
    temperature: 81,
    vibration: 2.7,
    pressure: 101.3,
    flowrate: 12.5,
  });
});
