"use client";

import { useState, type ReactNode } from "react";

import { apiDownload, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { getLocale, hasMessage, tr, useT } from "@/lib/i18n";

/** Shared pieces of the reports page (PRD go-live 2 §2). */

export function formatIDR(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}

/** 2026-11-17 -> 17 Nov 2026; 2026-11 -> Nov 2026, in the reader's language. Calendar strings from the API are shown as they are, never re-zoned. */
export function formatDay(ymd: string | null | undefined): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  const at = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
  const intl = getLocale() === "en" ? "en-GB" : "id-ID";
  return d
    ? at.toLocaleDateString(intl, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })
    : at.toLocaleDateString(intl, { timeZone: "UTC", month: "short", year: "numeric" });
}

/** `reports.<group>.<value>` when there is one, else the value itself. */
function labelFrom(group: string, value: string): string {
  const key = `reports.${group}.${value}`;
  return hasMessage(key) ? tr(key) : value;
}
export const paymentMethodLabel = (v: string) => labelFrom("method", v);
export const paymentStatusLabel = (v: string) => labelFrom("paymentStatus", v);
export const invoiceStatusLabel = (v: string) => labelFrom("invoiceStatus", v);
export const ledgerAccountLabel = (v: string) => labelFrom("ledgerAccount", v);

/** "Unduh CSV" — downloads `path` and lets the API name the file. */
export function DownloadCsvButton({ path, label, fallbackName }: { path: string; label?: string; fallbackName: string }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      await apiDownload(path, authClient.getToken(), fallbackName);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("reports.downloadFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="rounded border border-brand-600/20 bg-white px-3 py-1.5 text-sm font-medium hover:bg-brand-700/5 disabled:opacity-50"
      >
        {busy ? t("common.downloading") : (label ?? t("common.downloadCsv"))}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}

export function SectionHeader({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-medium">{title}</h2>
        {hint && <p className="mt-0.5 text-sm text-brand-700/60">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border border-brand-600/10 bg-white p-4">
      <p className="text-xs text-brand-700/60">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {sub && <p className="mt-1 text-xs text-brand-700/60">{sub}</p>}
    </div>
  );
}

export function LoadError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </p>
  );
}
