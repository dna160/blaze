"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "./api";
import { authClient } from "./auth-client";

export interface MessagingPauseState {
  paused: boolean;
  reason: string | null;
  pausedAt: string | null;
  pausedByUserId: string | null;
  /** SUPPRESSED notifications waiting for review before unpausing. */
  suppressedCount: number;
}

const REFRESH_EVENT = "rentos:messaging-pause-changed";
const POLL_MS = 60_000;

/** Re-read the pause state now — called right after Settings → Messaging toggles it. */
export function notifyMessagingPauseChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(REFRESH_EVENT));
}

/**
 * PRD go-live §9.1 — whether the organization's outbound messaging is paused.
 * Read by the shell on every page for the red banner. Like the nav badges, a
 * failed read resolves to "not known" (null) and hides the banner rather than
 * breaking navigation.
 */
export function useMessagingPause(): MessagingPauseState | null {
  const [state, setState] = useState<MessagingPauseState | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const token = authClient.getToken();
      if (!token) return;
      try {
        const data = await apiFetch<MessagingPauseState>("/organization/messaging/pause", { token });
        if (!cancelled) setState(data);
      } catch {
        if (!cancelled) setState(null);
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

  return state;
}
