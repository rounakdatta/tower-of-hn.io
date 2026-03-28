import { WSMessage } from "./types";

type MessageHandler = (msg: WSMessage) => void;

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8080/ws";

class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private maxBackoff = 10000;

  connect() {
    if (typeof window === "undefined") return;

    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      this.backoff = 1000;
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);
        const typeHandlers = this.handlers.get(msg.type);
        if (typeHandlers) {
          typeHandlers.forEach((handler) => handler(msg));
        }
        // Also notify wildcard subscribers
        const allHandlers = this.handlers.get("*");
        if (allHandlers) {
          allHandlers.forEach((handler) => handler(msg));
        }
      } catch {
        // ignore parse errors
      }
    };

    this.ws.onclose = () => {
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) return;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
      this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    }, this.backoff);
  }

  subscribe(eventType: string, handler: MessageHandler) {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);

    return () => {
      this.handlers.get(eventType)?.delete(handler);
    };
  }

  send(data: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    this.ws?.close();
  }
}

// Singleton
export const wsClient = new WebSocketClient();
