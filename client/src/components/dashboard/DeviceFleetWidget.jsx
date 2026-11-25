import { BatteryMedium, Cpu, Radio, Wifi } from "lucide-react";
import { summarizeFleet } from "./deviceFleet.js";

function formatAverage(value, suffix = "") {
  return value === null ? "--" : `${Math.round(value)}${suffix}`;
}

export default function DeviceFleetWidget({ devices = [] }) {
  const summary = summarizeFleet(devices);
  const signalLabel = summary.signalUnit === "dBm"
    ? `${formatAverage(summary.averageSignal)} dBm`
    : formatAverage(summary.averageSignal, summary.signalUnit ?? "");
  const activeCount = summary.onlineCount + summary.offlineCount === 0
    ? "--"
    : summary.onlineCount;
  const statusLabel = summary.totalCount === 0
    ? "No device data reported"
    : `${summary.onlineCount} online · ${summary.offlineCount} offline · ${summary.unknownStatusCount} unknown`;

  return (
    <section className="fleet-panel" aria-labelledby="fleet-title">
      <div className="fleet-heading">
        <div>
          <div className="telemetry-eyebrow">DEVICE MONITORING</div>
          <h2 id="fleet-title">Device fleet</h2>
        </div>
        <span className="fleet-device-count">
          {summary.totalCount} {summary.totalCount === 1 ? "device" : "devices"} reported
        </span>
      </div>

      <div className="fleet-cards">
        <article className="fleet-card">
          <span className="fleet-card-icon is-active"><Cpu size={17} aria-hidden="true" /></span>
          <div className="fleet-card-label">Active devices</div>
          <strong>{activeCount}</strong>
          <span className="fleet-card-detail">
            {summary.totalCount > 0 && summary.unknownStatusCount === summary.totalCount
              ? "Awaiting device status"
              : `${summary.onlineCount} of ${summary.totalCount} reported`}
          </span>
        </article>

        <article className="fleet-card">
          <span className="fleet-card-icon is-battery"><BatteryMedium size={17} aria-hidden="true" /></span>
          <div className="fleet-card-label">Average battery</div>
          <strong>{formatAverage(summary.averageBattery, "%")}</strong>
          <span className="fleet-card-detail">
            {summary.averageBattery === null ? "Awaiting battery data" : "Across reporting devices"}
          </span>
        </article>

        <article className="fleet-card">
          <span className="fleet-card-icon is-status"><Wifi size={17} aria-hidden="true" /></span>
          <div className="fleet-card-label">Online / offline</div>
          <strong>{summary.totalCount === 0 ? "--" : `${summary.onlineCount} / ${summary.offlineCount}`}</strong>
          <span className="fleet-card-detail">{statusLabel}</span>
        </article>

        <article className="fleet-card">
          <span className="fleet-card-icon is-signal"><Radio size={17} aria-hidden="true" /></span>
          <div className="fleet-card-label">Average signal</div>
          <strong>{signalLabel}</strong>
          <span className="fleet-card-detail">
            {summary.averageSignal === null ? "Awaiting signal data" : "Across reporting devices"}
          </span>
        </article>
      </div>
    </section>
  );
}
