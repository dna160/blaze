"use client";

import { DEFAULT_CONSOLE_NAME, type ConsoleBranding } from "@rentos/contracts";
import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";

/**
 * PRD go-live 2 §9.2 — the console's name and logo come from the organization
 * (`Organization.branding.consoleName`, the logo stored on the branch), not
 * from the code. Read from the public GET /branch/branding so the sign-in page
 * has it before anyone is signed in; cached in this browser so the name does
 * not flash from the default on every page.
 */

const CACHE_KEY = "rentos_console_branding";
let inflight: Promise<ConsoleBranding | null> | null = null;
const listeners = new Set<(b: ConsoleBranding) => void>();

function readCache(): ConsoleBranding | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as ConsoleBranding) : null;
  } catch {
    return null;
  }
}

function writeCache(b: ConsoleBranding) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(b));
  } catch {
    /* fine: fetched again next time */
  }
}

/** Fetch once per page load; every hook instance shares the answer. */
function load(): Promise<ConsoleBranding | null> {
  inflight ??= apiFetch<ConsoleBranding>("/branch/branding")
    .then((b) => {
      writeCache(b);
      for (const l of listeners) l(b);
      return b;
    })
    .catch(() => null);
  return inflight;
}

/** After Settings → Branch saves a new name: show it everywhere now. */
export function refreshBranding() {
  inflight = null;
  void load();
}

export function useConsoleBranding(): ConsoleBranding {
  const [branding, setBranding] = useState<ConsoleBranding>({ consoleName: DEFAULT_CONSOLE_NAME, branchName: "", logoDataUrl: null });
  useEffect(() => {
    const cached = readCache();
    if (cached) setBranding(cached);
    listeners.add(setBranding);
    void load().then((b) => b && setBranding(b));
    return () => {
      listeners.delete(setBranding);
    };
  }, []);
  useEffect(() => {
    document.title = branding.consoleName;
  }, [branding.consoleName]);
  return branding;
}

/** The logo (when the branch has one) and the console name, as the sidebar and sign-in pages show them. */
export function brandLabel(b: ConsoleBranding): string {
  return b.consoleName || DEFAULT_CONSOLE_NAME;
}
