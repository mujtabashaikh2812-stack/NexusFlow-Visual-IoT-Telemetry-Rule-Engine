import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const WINDOW_MS = 30_000;

function createSample(timestamp, previous, offset = 0) {
  const temperature = previous?.temperature ?? 74;
  const vibration = previous?.vibration ?? 3.2;

  return {
    timestamp,
    temperature: Number(
      Math.max(
        65,
        Math.min(
          90,
          temperature + Math.sin(offset / 4) * 0.45 + (Math.random() - 0.5) * 0.7,
        ),
      ).toFixed(1),
    ),
    vibration: Number(
      Math.max(
        0.5,
        Math.min(
          8,
          vibration + Math.cos(offset / 5) * 0.18 + (Math.random() - 0.5) * 0.35,
        ),
      ).toFixed(2),
    ),
  };
}

function createInitialSamples(now) {
  const samples = [];

  for (let secondsAgo = 30; secondsAgo >= 0; secondsAgo -= 1) {
    samples.push(
      createSample(
        now - secondsAgo * 1000,
        samples[samples.length - 1],
        30 - secondsAgo,
      ),
    );
  }

  return samples;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    minute: "2-digit",
    second: "2-digit",
  });
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) {
    return null;
  }

  return (
    <div className="telemetry-tooltip">
      <p>{formatTime(label)}</p>
      {payload.map((entry) => (
        <div className="telemetry-tooltip-value" key={entry.dataKey}>
          <span style={{ backgroundColor: entry.color }} />
          {entry.name}: {entry.value} {entry.dataKey === "temperature" ? "°C" : "mm/s"}
        </div>
      ))}
    </div>
  );
}

export default function TelemetryChart({ data }) {
  const [demoData, setDemoData] = useState(() => createInitialSamples(Date.now()));
  const [now, setNow] = useState(() => Date.now());
  const isDemo = !Array.isArray(data);

  useEffect(() => {
    if (!isDemo) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      const timestamp = Date.now();
      setDemoData((currentData) => {
        const nextSample = createSample(timestamp, currentData[currentData.length - 1]);
        return [
          ...currentData.filter((sample) => sample.timestamp >= timestamp - WINDOW_MS),
          nextSample,
        ];
      });
      setNow(timestamp);
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [isDemo]);

  useEffect(() => {
    if (!isDemo) {
      setNow(Date.now());
    }
  }, [data, isDemo]);

  const chartData = useMemo(() => {
    const samples = isDemo ? demoData : data;
    return samples.filter(
      (sample) =>
        sample &&
        Number.isFinite(sample.timestamp) &&
        Number.isFinite(sample.temperature) &&
        Number.isFinite(sample.vibration) &&
        sample.timestamp >= now - WINDOW_MS &&
        sample.timestamp <= now,
    );
  }, [data, demoData, isDemo, now]);

  const latest = chartData[chartData.length - 1];

  return (
    <section className="telemetry-panel" aria-labelledby="telemetry-title">
      <div className="telemetry-heading">
        <div>
          <div className="telemetry-eyebrow">LIVE MONITORING</div>
          <h2 id="telemetry-title">Telemetry waveform</h2>
          <p>Temperature and vibration over the last 30 seconds</p>
        </div>
        <span className={`telemetry-live-badge${isDemo ? " is-demo" : ""}`}>
          <span />
          {isDemo ? "DEMO STREAM" : "LIVE"}
        </span>
      </div>

      <div className="telemetry-readings" aria-live="polite">
        <div className="telemetry-reading">
          <span className="telemetry-reading-dot temperature-dot" />
          <span className="telemetry-reading-label">Temperature</span>
          <strong>{latest ? `${latest.temperature}°C` : "--"}</strong>
        </div>
        <div className="telemetry-reading">
          <span className="telemetry-reading-dot vibration-dot" />
          <span className="telemetry-reading-label">Vibration</span>
          <strong>{latest ? `${latest.vibration} mm/s` : "--"}</strong>
        </div>
      </div>

      <div
        className="telemetry-chart"
        role="img"
        aria-label="Live temperature and vibration chart for the last 30 seconds"
      >
        {chartData.length === 0 ? (
          <div className="telemetry-empty">Waiting for telemetry samples…</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              margin={{ top: 8, right: 12, bottom: 0, left: -12 }}
            >
              <CartesianGrid stroke="#252e3d" strokeDasharray="3 5" vertical={false} />
              <XAxis
                dataKey="timestamp"
                type="number"
                scale="time"
                domain={[now - WINDOW_MS, now]}
                tickFormatter={formatTime}
                tick={{ fill: "#788397", fontSize: 10 }}
                axisLine={{ stroke: "#30394a" }}
                tickLine={false}
                minTickGap={28}
              />
              <YAxis
                yAxisId="temperature"
                domain={["auto", "auto"]}
                tick={{ fill: "#f0aa78", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickCount={5}
                width={42}
              />
              <YAxis
                yAxisId="vibration"
                orientation="right"
                domain={["auto", "auto"]}
                tick={{ fill: "#83d9bb", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickCount={5}
                width={42}
              />
              <Tooltip content={<ChartTooltip />} />
              <Line
                yAxisId="temperature"
                type="monotone"
                dataKey="temperature"
                name="Temperature"
                stroke="#f0aa78"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0 }}
                isAnimationActive={false}
                connectNulls
              />
              <Line
                yAxisId="vibration"
                type="monotone"
                dataKey="vibration"
                name="Vibration"
                stroke="#55d6a5"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0 }}
                isAnimationActive={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="telemetry-chart-footer">
        <span>{formatTime(now - WINDOW_MS)}</span>
        <span>30-second rolling window</span>
        <span>{formatTime(now)}</span>
      </div>
    </section>
  );
}
