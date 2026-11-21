"use client";

import { useEffect, useState } from "react";
import type { ChangeRequestSummaryDto } from "@rentos/contracts";

import { apiFetch } from "./api";
import { authClient } from "./auth-client";

const REFRESH_EVENT = "rentos:change-requests-changed";
const POLL_MS = 60_000;

/** Tell the sidebar's Requests badge to re-count now (after filing or deciding a request). */
export function notifyChangeRequestsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(REFRESH_EVENT));
}

const EMPTY: ChangeRequestSummaryDto = { pendingForMe: 0, approvableTypes: [], canRequest: false };

/**
 * PRD go-live 2 §4.1 — pending booking change requests the signed-in user
 * could decide, for the sidebar badge. Same discipline as the other badges:
 * every failure reads as "nothing", never breaks the shell.
 */
export function useChangeRequestSummary(): ChangeRequestSummaryDto {
  const [summary, setSummary] = useState<ChangeRequestSummaryDto>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const token = authClient.getToken();
      if (!token) {
        if (!cancelled) setSummary(EMPTY);
        return;
      }
      try {
        const data = await apiFetch<ChangeRequestSummaryDto>("/change-requests/summary", { token });
        if (!cancelled) setSummary(data);
      } catch {
        if (!cancelled) setSummary(EMPTY);
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

  return summary;
}

export const CHANGE_TYPE_LABEL: Record<string, string> = {
  CANCEL: "Pembatalan",
  CHANGE_START_DATE: "Ubah tanggal mulai",
};

export const CHANGE_STATUS_LABEL: Record<string, string> = {
  PENDING: "Menunggu keputusan",
  APPROVED: "Disetujui",
  REJECTED: "Ditolak",
  WITHDRAWN: "Ditarik",
};

export const CHANGE_STATUS_STYLE: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800",
  APPROVED: "bg-green-100 text-green-800",
  REJECTED: "bg-red-100 text-red-700",
  WITHDRAWN: "bg-brand-700/10 text-brand-700/70",
};

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
}
