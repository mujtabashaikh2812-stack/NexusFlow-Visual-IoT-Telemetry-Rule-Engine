import { useEffect, useState } from "react";
import {
  createSocketService,
  TELEMETRY_CHANNELS,
} from "../services/socketService.js";
import { getFleetDeviceUpdates } from "../components/dashboard/deviceFleet.js";

const TELEMETRY_WINDOW_MS = 30_000;

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === "string" && value.trim()) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      return numericValue < 1_000_000_000_000
        ? numericValue * 1000
        : numericValue;
    }

    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) {
      return parsedDate;
    }
  }

  return Date.now();
}

function parseValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : null;
  }

  return null;
}

function normalizeSensorType(value) {
  const sensorType = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

  if (sensorType.startsWith("temp")) {
    return "temperature";
  }
  if (sensorType.startsWith("vib")) {
    return "vibration";
  }
  if (sensorType === "pressure") {
    return "pressure";
  }
  if (sensorType === "flow" || sensorType === "flowrate") {
    return "flowrate";
  }

  return null;
}

export function getTelemetryPoints(payload, latestValues) {
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.readings)
      ? payload.readings
      : [payload];
  const points = [];

  records.forEach((record) => {
    const reading = record?.data && typeof record.data === "object"
      ? record.data
      : record;
    if (!reading || typeof reading !== "object") {
      return;
    }

    const timestamp = parseTimestamp(
      reading.timestamp ?? reading.ts ?? reading.time,
    );
    const directTemperature = parseValue(reading.temperature);
    const directVibration = parseValue(reading.vibration);

    if (directTemperature !== null) {
      latestValues.temperature = directTemperature;
    }
    if (directVibration !== null) {
      latestValues.vibration = directVibration;
    }

    if (directTemperature !== null && directVibration !== null) {
      points.push({ timestamp, temperature: directTemperature, vibration: directVibration });
      return;
    }

    const sensorType = normalizeSensorType(reading.sensorType ?? reading.type);
    const value = parseValue(reading.value ?? reading.reading);

    if (sensorType && value !== null) {
      latestValues[sensorType] = value;
    }

    if (!sensorType || value === null) {
      if (
        latestValues.temperature !== null &&
        latestValues.vibration !== null &&
        (directTemperature !== null || directVibration !== null)
      ) {
        points.push({
          timestamp,
          temperature: latestValues.temperature,
          vibration: latestValues.vibration,
        });
      }
      return;
    }

    if (
      (sensorType === "temperature" || sensorType === "vibration") &&
      latestValues.temperature !== null &&
      latestValues.vibration !== null
    ) {
      points.push({
        timestamp,
        temperature: latestValues.temperature,
        vibration: latestValues.vibration,
      });
    }
  });

  return points;
}

function getSocketUrl() {
  const configuredUrl = import.meta.env.VITE_WS_URL;
  if (configuredUrl) {
    return configuredUrl;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:3000`;
}

export default function useTelemetryStream() {
  const [service] = useState(() => createSocketService(getSocketUrl()));
  const [telemetry, setTelemetry] = useState([]);
  const [fleetDevices, setFleetDevices] = useState([]);
  const [latestSensorValues, setLatestSensorValues] = useState({});
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [connectionError, setConnectionError] = useState("");
  const [lastRuleTriggered, setLastRuleTriggered] = useState(null);

  useEffect(() => {
    const latestValues = { temperature: null, vibration: null };
    const unsubscribeTelemetry = service.subscribe(
      TELEMETRY_CHANNELS[0],
      (payload) => {
        const deviceUpdates = getFleetDeviceUpdates(payload);
        if (deviceUpdates.length > 0) {
          setFleetDevices((currentDevices) => {
            const devicesById = new Map(
              currentDevices.map((device) => [device.id, device]),
            );
            deviceUpdates.forEach((update) => {
              const previous = devicesById.get(update.id);
              devicesById.set(update.id, {
                ...previous,
                ...update,
                name: update.name === update.id
                  ? previous?.name ?? update.name
                  : update.name,
                status: update.status ?? previous?.status ?? null,
                battery: update.battery ?? previous?.battery ?? null,
                signal: update.signal ?? previous?.signal ?? null,
                signalUnit: update.signalUnit ?? previous?.signalUnit ?? null,
              });
            });
            return Array.from(devicesById.values());
          });
        }

        const previousValues = { ...latestValues };
        const points = getTelemetryPoints(payload, latestValues);
        if (
          Object.keys(latestValues).some(
            (sensorType) => latestValues[sensorType] !== previousValues[sensorType],
          )
        ) {
          setLatestSensorValues({ ...latestValues });
        }

        if (points.length > 0) {
          const cutoff = Date.now() - TELEMETRY_WINDOW_MS;
          setTelemetry((currentData) =>
            [...currentData, ...points]
              .filter((point) => point.timestamp >= cutoff)
              .sort((left, right) => left.timestamp - right.timestamp),
          );
        }
      },
    );
    const unsubscribeRule = service.subscribe(
      TELEMETRY_CHANNELS[1],
      (payload) => {
        setLastRuleTriggered({
          payload,
          receivedAt: Date.now(),
        });
      },
    );
    const unsubscribeStatus = service.subscribeStatus(setConnectionStatus);
    const unsubscribeErrors = service.subscribeErrors((error) => {
      setConnectionError(error.message || "WebSocket connection failed.");
    });

    service.connect();

    return () => {
      unsubscribeTelemetry();
      unsubscribeRule();
      unsubscribeStatus();
      unsubscribeErrors();
      service.disconnect();
    };
  }, [service]);

  useEffect(() => {
    if (connectionStatus === "connected") {
      setConnectionError("");
    }
  }, [connectionStatus]);

  return {
    connectionError,
    connectionStatus,
    fleetDevices,
    lastRuleTriggered,
    latestSensorValues,
    telemetry,
  };
}
