"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "./api";
import { authClient } from "./auth-client";

const REFRESH_EVENT = "rentos:pending-approvals-changed";
const POLL_MS = 60_000;

/**
 * Tell the sidebar badge to re-count now. Pages that approve, reject or
 * otherwise move a booking out of PENDING_APPROVAL call this so the badge
 * drops immediately instead of waiting out the poll interval.
 */
export function notifyPendingApprovalsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(REFRESH_EVENT));
}

/**
 * Count of bookings awaiting staff approval, for the sidebar badge.
 *
 * Refreshes on mount, on a slow poll, when the tab regains focus, and when
 * a page signals a change. Every failure is swallowed and reported as 0:
 * the shell renders on every console page, so a 401/403/network blip must
 * cost the badge, never the navigation.
 */
export function usePendingApprovalCount(): number {
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
        const data = await apiFetch<{ pendingApproval: number }>("/bookings/pending-count", { token });
        if (!cancelled) setCount(data.pendingApproval ?? 0);
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
