"use client";

import { useEffect } from "react";
import { wsClient } from "@/lib/ws";
import { WSMessage } from "@/lib/types";

export function useWebSocket(
  eventType: string,
  handler: (msg: WSMessage) => void
) {
  useEffect(() => {
    wsClient.connect();
    const unsubscribe = wsClient.subscribe(eventType, handler);
    return unsubscribe;
  }, [eventType, handler]);
}
