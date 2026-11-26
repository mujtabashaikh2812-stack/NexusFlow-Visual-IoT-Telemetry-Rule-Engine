import { useEffect, useRef, useState } from "react";
import { BellRing, X } from "lucide-react";
import "./AlertNotificationToast.css";

const TOAST_DURATION_MS = 6000;

function getAlertMessage(payload) {
  if (typeof payload === "string" && payload.trim()) {
    return payload;
  }

  const message =
    payload?.message ??
    payload?.ruleName ??
    payload?.name ??
    payload?.ruleId ??
    "A rule condition was triggered.";
  return typeof message === "string" || typeof message === "number"
    ? String(message)
    : "A rule condition was triggered.";
}

function playChime(contextRef, onUnavailable) {
  const AudioContextImpl = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextImpl) {
    onUnavailable();
    return;
  }

  try {
    contextRef.current ??= new AudioContextImpl();
    const context = contextRef.current;
    const playNotes = () => {
      [[784, 0], [1046, 0.16]].forEach(([frequency, offset]) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const startAt = context.currentTime + offset;

        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(0.12, startAt + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.2);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(startAt);
        oscillator.stop(startAt + 0.21);
      });
    };

    if (context.state === "suspended") {
      context.resume().then(playNotes).catch(onUnavailable);
    } else {
      playNotes();
    }
  } catch {
    onUnavailable();
  }
}

export default function AlertNotificationToast({ notification }) {
  const [activeNotification, setActiveNotification] = useState(null);
  const [soundUnavailable, setSoundUnavailable] = useState(false);
  const audioContextRef = useRef(null);

  useEffect(() => {
    if (!notification) {
      return undefined;
    }

    setActiveNotification(notification);
    setSoundUnavailable(false);
    playChime(audioContextRef, () => setSoundUnavailable(true));

    const timeout = window.setTimeout(
      () => setActiveNotification(null),
      TOAST_DURATION_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [notification]);

  useEffect(
    () => () => {
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        audioContextRef.current.close();
      }
    },
    [],
  );

  if (!activeNotification) {
    return null;
  }

  return (
    <aside
      className="alert-toast"
      key={activeNotification.receivedAt}
      role="alert"
      aria-live="assertive"
    >
      <span className="alert-toast-icon" aria-hidden="true">
        <BellRing size={19} />
      </span>
      <div className="alert-toast-content">
        <strong>Rule triggered</strong>
        <p>{getAlertMessage(activeNotification.payload)}</p>
        {soundUnavailable && (
          <button
            className="alert-toast-sound-retry"
            onClick={() =>
              playChime(audioContextRef, () => setSoundUnavailable(true))
            }
            type="button"
          >
            Play alert chime
          </button>
        )}
      </div>
      <button
        className="alert-toast-dismiss"
        onClick={() => setActiveNotification(null)}
        type="button"
        aria-label="Dismiss rule alert"
      >
        <X size={17} />
      </button>
      <span className="alert-toast-progress" aria-hidden="true" />
    </aside>
  );
}
