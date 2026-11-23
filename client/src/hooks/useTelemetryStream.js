import { useEffect, useState } from "react";
import {
  createSocketService,
  TELEMETRY_CHANNELS,
} from "../services/socketService.js";

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

    if (directTemperature !== null && directVibration !== null) {
      latestValues.temperature = directTemperature;
      latestValues.vibration = directVibration;
      points.push({ timestamp, temperature: directTemperature, vibration: directVibration });
      return;
    }

    const sensorType = String(reading.sensorType ?? reading.type ?? "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    const value = parseValue(reading.value ?? reading.reading);

    if (value === null) {
      return;
    }
    if (
      sensorType.startsWith("temp") ||
      sensorType.includes("temperature")
    ) {
      latestValues.temperature = value;
    } else if (
      sensorType.startsWith("vib") ||
      sensorType.includes("vibration")
    ) {
      latestValues.vibration = value;
    } else {
      return;
    }

    if (
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
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [connectionError, setConnectionError] = useState("");
  const [lastRuleTriggered, setLastRuleTriggered] = useState(null);

  useEffect(() => {
    const latestValues = { temperature: null, vibration: null };
    const unsubscribeTelemetry = service.subscribe(
      TELEMETRY_CHANNELS[0],
      (payload) => {
        const points = getTelemetryPoints(payload, latestValues);
        if (points.length === 0) {
          return;
        }

        const cutoff = Date.now() - TELEMETRY_WINDOW_MS;
        setTelemetry((currentData) =>
          [...currentData, ...points]
            .filter((point) => point.timestamp >= cutoff)
            .sort((left, right) => left.timestamp - right.timestamp),
        );
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
    lastRuleTriggered,
    telemetry,
  };
}
