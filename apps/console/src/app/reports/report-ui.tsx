"use client";

import { useState, type ReactNode } from "react";

import { apiDownload, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

/** Shared pieces of the reports page (PRD go-live 2 §2). */

export function formatIDR(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}

/** 2026-11-17 -> 17 Nov 2026; 2026-11 -> Nov 2026. Calendar strings from the API are shown as they are, never re-zoned. */
export function formatDay(ymd: string | null | undefined): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-");
  const month = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"][Number(m) - 1] ?? m;
  return d ? `${Number(d)} ${month} ${y}` : `${month} ${y}`;
}

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  MANUAL_TRANSFER: "Transfer bank",
  CASH: "Tunai",
  VIRTUAL_ACCOUNT: "Virtual account (Xendit)",
  QRIS: "QRIS (Xendit)",
  EWALLET: "E-wallet (Xendit)",
  CARD: "Kartu (Xendit)",
};

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  SUCCEEDED: "Sukses",
  PENDING: "Menunggu verifikasi",
  FAILED: "Gagal",
  REFUNDED: "Dikembalikan",
  PARTIALLY_REFUNDED: "Dikembalikan sebagian",
};

export const INVOICE_STATUS_LABEL: Record<string, string> = {
  ISSUED: "Terbit",
  OVERDUE: "Terlambat",
  SCHEDULED: "Terjadwal",
};

export const LEDGER_ACCOUNT_LABEL: Record<string, string> = {
  CASH: "Kas",
  ACCOUNTS_RECEIVABLE: "Piutang usaha",
  PREPAID_TAX_PPH: "PPh dibayar di muka",
  REVENUE: "Pendapatan",
  TAX_PAYABLE: "Utang PPN",
  DEPOSIT_LIABILITY: "Deposit pelanggan (kewajiban)",
  REFUND: "Pengembalian dana",
  OPENING_BALANCE: "Saldo awal (impor)",
};

/** "Unduh CSV" — downloads `path` and lets the API name the file. */
export function DownloadCsvButton({ path, label = "Unduh CSV", fallbackName }: { path: string; label?: string; fallbackName: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      await apiDownload(path, authClient.getToken(), fallbackName);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unduhan gagal.");
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
        {busy ? "Mengunduh…" : label}
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
