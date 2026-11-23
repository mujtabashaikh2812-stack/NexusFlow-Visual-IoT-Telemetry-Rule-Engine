export const TELEMETRY_CHANNELS = ["telemetry:stream", "rule:triggered"];

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 15000;

export function createSocketService(url, WebSocketImpl = globalThis.WebSocket) {
  const listeners = new Map();
  const statusListeners = new Set();
  const errorListeners = new Set();
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let manuallyDisconnected = false;
  let status = "disconnected";

  function setStatus(nextStatus) {
    status = nextStatus;
    statusListeners.forEach((listener) => listener(status));
  }

  function reportError(error) {
    errorListeners.forEach((listener) => listener(error));
  }

  function dispatchMessage(rawMessage) {
    let message;

    try {
      message = JSON.parse(rawMessage.data);
    } catch {
      reportError(new Error("Received an invalid JSON message from the WebSocket server."));
      return;
    }

    if (!message || typeof message !== "object" || Array.isArray(message)) {
      reportError(new Error("Received an unsupported WebSocket message."));
      return;
    }

    const channel = message.event ?? message.channel ?? message.type;
    if (typeof channel !== "string") {
      reportError(new Error("Received a WebSocket message without a channel."));
      return;
    }

    const payload = Object.hasOwn(message, "data") ? message.data : message.payload;
    listeners.get(channel)?.forEach((listener) => listener(payload));
  }

  function scheduleReconnect() {
    if (manuallyDisconnected || reconnectTimer !== null) {
      return;
    }

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );
    reconnectAttempts += 1;
    reconnectTimer = globalThis.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (
      socket &&
      (socket.readyState === WebSocketImpl?.OPEN ||
        socket.readyState === WebSocketImpl?.CONNECTING)
    ) {
      return;
    }

    manuallyDisconnected = false;
    setStatus("connecting");

    let nextSocket;
    try {
      if (typeof WebSocketImpl !== "function") {
        throw new Error("WebSocket is not available in this environment.");
      }
      nextSocket = new WebSocketImpl(url);
    } catch (error) {
      reportError(error);
      setStatus("error");
      scheduleReconnect();
      return;
    }

    socket = nextSocket;

    nextSocket.addEventListener("open", () => {
      if (socket !== nextSocket) {
        return;
      }

      reconnectAttempts = 0;
      setStatus("connected");
      try {
        nextSocket.send(
          JSON.stringify({ type: "subscribe", channels: TELEMETRY_CHANNELS }),
        );
      } catch (error) {
        reportError(error);
        nextSocket.close();
      }
    });

    nextSocket.addEventListener("message", dispatchMessage);
    nextSocket.addEventListener("error", () => {
      if (socket === nextSocket) {
        reportError(new Error("WebSocket connection error."));
        setStatus("error");
      }
    });
    nextSocket.addEventListener("close", () => {
      if (socket !== nextSocket) {
        return;
      }

      socket = null;
      if (manuallyDisconnected) {
        setStatus("disconnected");
        return;
      }

      setStatus("reconnecting");
      scheduleReconnect();
    });
  }

  function disconnect() {
    manuallyDisconnected = true;
    if (reconnectTimer !== null) {
      globalThis.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const currentSocket = socket;
    socket = null;
    if (currentSocket && currentSocket.readyState < 2) {
      currentSocket.close();
    }

    setStatus("disconnected");
  }

  function subscribe(channel, listener) {
    if (!listeners.has(channel)) {
      listeners.set(channel, new Set());
    }
    listeners.get(channel).add(listener);

    return () => {
      const channelListeners = listeners.get(channel);
      channelListeners?.delete(listener);
      if (channelListeners?.size === 0) {
        listeners.delete(channel);
      }
    };
  }

  function subscribeStatus(listener) {
    statusListeners.add(listener);
    listener(status);
    return () => statusListeners.delete(listener);
  }

  function subscribeErrors(listener) {
    errorListeners.add(listener);
    return () => errorListeners.delete(listener);
  }

  return {
    connect,
    disconnect,
    subscribe,
    subscribeErrors,
    subscribeStatus,
  };
}
