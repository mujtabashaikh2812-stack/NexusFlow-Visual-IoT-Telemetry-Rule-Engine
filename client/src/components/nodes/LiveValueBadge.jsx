import { createContext, useContext } from "react";

const LiveValueContext = createContext({
  isConnected: false,
  values: {},
});

const sensorMetadata = {
  flowrate: { label: "Flow rate", unit: "" },
  pressure: { label: "Pressure", unit: "" },
  temperature: { label: "Temperature", unit: "°C" },
  vibration: { label: "Vibration", unit: "mm/s" },
};

function normalizeSensorType(sensorType) {
  return String(sensorType ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function formatValue(value) {
  return Number(value.toFixed(2)).toString();
}

export function LiveValueProvider({ children, isConnected, values }) {
  return (
    <LiveValueContext.Provider
      value={{ isConnected, values: values ?? {} }}
    >
      {children}
    </LiveValueContext.Provider>
  );
}

export function useLiveValues() {
  return useContext(LiveValueContext);
}

export default function LiveValueBadge({ sensorType }) {
  const { isConnected, values } = useContext(LiveValueContext);
  const sensorKey = normalizeSensorType(sensorType);
  const metadata = sensorMetadata[sensorKey] ?? {
    label: sensorType,
    unit: "",
  };
  const value = values[sensorKey];
  const hasValue = Number.isFinite(value);
  const state = hasValue ? (isConnected ? "live" : "offline") : "waiting";

  return (
    <div
      className="live-value-badge"
      data-state={state}
      aria-label={
        hasValue
          ? `${metadata.label}: ${formatValue(value)}${metadata.unit ? ` ${metadata.unit}` : ""}, ${state === "live" ? "live" : "last received"}`
          : `${metadata.label}: waiting for telemetry`
      }
      aria-live="polite"
    >
      <span className="live-value-badge-label">{metadata.label}</span>
      <strong>{hasValue ? formatValue(value) : "--"}</strong>
      {metadata.unit && <span className="live-value-badge-unit">{metadata.unit}</span>}
      <span className="live-value-badge-state">
        {hasValue ? (isConnected ? "Live" : "Last received") : "Waiting"}
      </span>
    </div>
  );
}
