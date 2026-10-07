import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { wsUrl } from "@/src/api";

type Msg = { message_id: string; sender_id: string; sender_name: string; sender_picture?: string | null; text: string; created_at: string };

// Realtime chat socket: new messages + typing indicators. Reconnects with backoff; the screen
// keeps a slow poll as a safety net so nothing is lost if the socket is down.
export function useLiveChat(chatId: string, token: string | null, onMessage: (m: Msg) => void) {
  const [connected, setConnected] = useState(false);
  const [typing, setTyping] = useState<Record<string, string>>({});
  const ws = useRef<WebSocket | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const lastTyping = useRef(0);
  const onMsg = useRef(onMessage);
  onMsg.current = onMessage;

  useEffect(() => {
    if (!token || !chatId) return;
    let alive = true, attempt = 0, retry: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      if (!alive) return;
      const sock = new WebSocket(`${wsUrl(`/ws/chats/${chatId}`)}?token=${encodeURIComponent(token)}`);
      ws.current = sock;
      sock.onopen = () => { attempt = 0; setConnected(true); };
      sock.onmessage = (e) => {
        try {
          const d = JSON.parse(String(e.data));
          if (d.type === "message") onMsg.current(d.message);
          if (d.type === "typing") {
            setTyping((t) => { const n = { ...t }; if (d.on) n[d.user_id] = d.name; else delete n[d.user_id]; return n; });
            if (timers.current[d.user_id]) clearTimeout(timers.current[d.user_id]);
            if (d.on) timers.current[d.user_id] = setTimeout(() => setTyping((t) => { const n = { ...t }; delete n[d.user_id]; return n; }), 4000);
          }
        } catch {}
      };
      sock.onclose = () => {
        setConnected(false);
        if (!alive) return;
        retry = setTimeout(open, Math.min(15000, 1000 * 2 ** attempt++));
      };
      sock.onerror = () => sock.close();
    };
    open();
    const sub = AppState.addEventListener("change", (st) => { if (st === "active" && ws.current?.readyState !== WebSocket.OPEN) { attempt = 0; open(); } });
    return () => {
      alive = false;
      sub.remove();
      if (retry) clearTimeout(retry);
      ws.current?.close();
      Object.values(timers.current).forEach(clearTimeout);
    };
  }, [chatId, token]);

  const sendTyping = useCallback((on = true) => {
    const nowMs = Date.now();
    if (on && nowMs - lastTyping.current < 1500) return;
    lastTyping.current = nowMs;
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "typing", on }));
  }, []);

  return { connected, typingNames: Object.values(typing), sendTyping };
}
