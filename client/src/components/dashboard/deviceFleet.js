function parseMetric(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : null;
  }

  return null;
}

function normalizeStatus(record) {
  if (typeof record.online === "boolean") {
    return record.online ? "online" : "offline";
  }
  if (typeof record.isOnline === "boolean") {
    return record.isOnline ? "online" : "offline";
  }

  const status = String(record.status ?? record.connectionStatus ?? "")
    .trim()
    .toLowerCase();
  if (["online", "connected"].includes(status)) {
    return "online";
  }
  if (["offline", "disconnected"].includes(status)) {
    return "offline";
  }

  return null;
}

export function getFleetDeviceUpdates(payload) {
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.readings)
      ? payload.readings
      : [payload];

  return records.flatMap((record) => {
    if (!record || typeof record !== "object") {
      return [];
    }

    const reading = record.data && typeof record.data === "object"
      ? { ...record, ...record.data }
      : record;
    const rawId = reading.deviceId ?? reading.device_id ?? reading.device ?? reading.id;
    if (typeof rawId !== "string" && typeof rawId !== "number") {
      return [];
    }
    const deviceId = String(rawId).trim();
    if (!deviceId) {
      return [];
    }

    const battery = parseMetric(
      reading.batteryLevel ?? reading.batteryPercent ?? reading.battery,
    );
    const signal = parseMetric(
      reading.rssi ?? reading.signalStrength ?? reading.signal,
    );
    const rawSignalUnit = reading.rssi !== undefined
      ? "dBm"
      : reading.signalStrengthUnit ?? reading.signalUnit ?? "%";
    const signalUnit = typeof rawSignalUnit === "string" ? rawSignalUnit : "%";

    return [{
      id: deviceId,
      name: typeof reading.deviceName === "string" && reading.deviceName.trim()
        ? reading.deviceName.trim()
        : deviceId,
      status: normalizeStatus(reading),
      battery: battery !== null && battery >= 0 && battery <= 100 ? battery : null,
      signal: signal !== null ? signal : null,
      signalUnit: signal !== null ? signalUnit : null,
    }];
  });
}

export function summarizeFleet(devices) {
  const onlineCount = devices.filter((device) => device.status === "online").length;
  const offlineCount = devices.filter((device) => device.status === "offline").length;
  const unknownStatusCount = devices.length - onlineCount - offlineCount;
  const batteryReadings = devices
    .map((device) => device.battery)
    .filter((value) => Number.isFinite(value));
  const signalReadings = devices.filter((device) => Number.isFinite(device.signal));
  const signalUnits = new Set(signalReadings.map((device) => device.signalUnit));

  return {
    totalCount: devices.length,
    onlineCount,
    offlineCount,
    unknownStatusCount,
    averageBattery: batteryReadings.length
      ? batteryReadings.reduce((total, value) => total + value, 0) / batteryReadings.length
      : null,
    averageSignal: signalReadings.length && signalUnits.size === 1
      ? signalReadings.reduce((total, device) => total + device.signal, 0) /
        signalReadings.length
      : null,
    signalUnit: signalUnits.size === 1 ? signalReadings[0].signalUnit : null,
  };
}
