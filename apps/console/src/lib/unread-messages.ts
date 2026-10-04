"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "./api";
import { authClient } from "./auth-client";

const REFRESH_EVENT = "rentos:unread-messages-changed";
const POLL_MS = 15_000;

/** Tell the nav badge to re-count now — called when a thread is opened and its unread clears. */
export function notifyUnreadMessagesChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(REFRESH_EVENT));
}

/**
 * Unread inbound WhatsApp messages across the branches this user can see.
 *
 * Same discipline as the approval badge: the shell renders on every page, so
 * any failure resolves to 0 and simply hides the badge. A 403 or a network blip
 * must cost the count, never the navigation.
 */
export function useUnreadMessageCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      const token = authClient.getToken();
      if (!token) {
        if (!cancelled) setCount(0);
        return;
      }
      try {
        const data = await apiFetch<{ count: number }>("/messaging/unread-count", { token });
        if (!cancelled) setCount(data.count ?? 0);
      } catch {
        if (!cancelled) setCount(0);
      }
    }

    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    window.addEventListener(REFRESH_EVENT, refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(REFRESH_EVENT, refresh);
    };
  }, []);

  return count;
}
