"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "./api";
import { authClient } from "./auth-client";

const REFRESH_EVENT = "rentos:branch-settings-changed";
const POLL_MS = 5 * 60_000;

/** Re-read the branch flags now — called right after Settings → Branch saves. */
export function notifyBranchSettingsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(REFRESH_EVENT));
}

/**
 * PRD go-live 2 §7.1 — whether this branch is in the client's test period
 * (`featureFlags.test_mode`). Read by the shell for the "data will be wiped"
 * banner. A failed read hides the banner rather than breaking navigation.
 */
export function useBranchTestMode(): boolean {
  const [testMode, setTestMode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const token = authClient.getToken();
      if (!token) return;
      try {
        const data = await apiFetch<{ testMode?: boolean }>("/branch/settings", { token });
        if (!cancelled) setTestMode(data.testMode === true);
      } catch {
        if (!cancelled) setTestMode(false);
      }
    }
    void refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener(REFRESH_EVENT, refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener(REFRESH_EVENT, refresh);
    };
  }, []);

  return testMode;
}
