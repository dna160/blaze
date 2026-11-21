"use client";

import type { DepositReport, DepositReportRow } from "@rentos/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, Suspense, useCallback, useEffect, useState } from "react";

import { ConsoleShell } from "@/components/ConsoleShell";
import { rangeQuery, ReportRange, useReportRange } from "@/components/ReportRange";
import { apiDownload, apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { canDo } from "@/lib/capabilities";

type DepositStatus = DepositReportRow["status"];

const STATUS_COLORS: Record<DepositStatus, string> = {
  HELD: "bg-blue-100 text-blue-800",
  REFUND_REQUESTED: "bg-amber-100 text-amber-800",
  REFUNDED: "bg-green-100 text-green-800",
  PARTIALLY_APPLIED: "bg-gray-200 text-gray-700",
  APPLIED: "bg-gray-200 text-gray-700",
};

const STATUS_LABELS: Record<DepositStatus, string> = {
  HELD: "Ditahan",
  PARTIALLY_APPLIED: "Dipotong sebagian",
  APPLIED: "Dipotong penuh",
  REFUND_REQUESTED: "Refund diminta",
  REFUNDED: "Sudah direfund",
};

const SOURCE_LABELS: Record<DepositReportRow["source"], string> = {
  RENTOS: "RentOS",
  LEGACY: "Booqable",
};

interface Filters {
  status: "" | DepositStatus;
  assetTypeId: string;
  source: "" | DepositReportRow["source"];
  refundOverdue: boolean;
  movedOnly: boolean;
}

const NO_FILTERS: Filters = { status: "", assetTypeId: "", source: "", refundOverdue: false, movedOnly: false };

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}

/** An instant as a date in the branch's timezone, e.g. "21 Nov 2026". */
function formatInstant(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("id-ID", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

/** A stored calendar date (YYYY-MM-DD) — printed as that date, never shifted. */
function formatCalendarDate(ymd: string | null): string {
  if (!ymd) return "—";
  return new Intl.DateTimeFormat("id-ID", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${ymd}T00:00:00Z`));
}

function filterQuery(f: Filters): string {
  const q = new URLSearchParams();
  if (f.status) q.set("status", f.status);
  if (f.assetTypeId) q.set("assetTypeId", f.assetTypeId);
  if (f.source) q.set("source", f.source);
  if (f.refundOverdue) q.set("refundOverdue", "1");
  if (f.movedOnly) q.set("movedOnly", "1");
  const s = q.toString();
  return s ? `&${s}` : "";
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warn" }) {
  return (
    <div className={`rounded-lg border p-3 ${tone === "warn" ? "border-red-200 bg-red-50" : "border-brand-600/10 bg-white"}`}>
      <p className="text-xs text-brand-700/60">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${tone === "warn" ? "text-red-700" : ""}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-brand-700/60">{hint}</p>}
    </div>
  );
}

/**
 * PRD go-live 2 §3.2 — the deposit page as a report: one date range (applied
 * to movement dates), filters, a totals strip, every date a deposit has, and a
 * CSV of exactly what is on screen. The actions of PRD §7.2.4 stay on the row:
 * apply against damages and approve a refund need approve_deposit_refund,
 * requesting a refund is open to any staff member.
 */
function DepositsReport() {
  const router = useRouter();
  const user = authClient.getUser();
  const { range, setRange, timeZone } = useReportRange({ userId: user?.id ?? null });
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [report, setReport] = useState<DepositReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyAmount, setApplyAmount] = useState("");
  const [applyReason, setApplyReason] = useState("");

  const load = useCallback(async () => {
    if (!range) return;
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    setLoading(true);
    try {
      setReport(await apiFetch<DepositReport>(`/deposits/report?${rangeQuery(range)}${filterQuery(filters)}`, { token }));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push("/login");
        return;
      }
      setError(err instanceof ApiError ? err.message : "Laporan deposit gagal dimuat.");
    } finally {
      setLoading(false);
    }
  }, [range, filters, router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, path: string, body: unknown, failure: string): Promise<boolean> {
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/deposits/${id}/${path}`, { token: authClient.getToken(), method: "POST", ...(body ? { body } : {}) });
      await load();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : failure);
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function applyToDamages(id: string) {
    if (!applyAmount || !applyReason) return;
    if (await act(id, "apply", { amount: applyAmount, reason: applyReason }, "Gagal memotong deposit.")) {
      setApplyingId(null);
      setApplyAmount("");
      setApplyReason("");
    }
  }

  async function download() {
    if (!range || !report) return;
    setDownloading(true);
    setError(null);
    try {
      await apiDownload(`/deposits/export.csv?${rangeQuery(range)}${filterQuery(filters)}`, authClient.getToken(), report.exportFilename);
    } catch {
      setError("Gagal mengunduh CSV.");
    } finally {
      setDownloading(false);
    }
  }

  // Requesting a refund is open to any staff member (StaffGuard on the API);
  // applying a deposit and approving a refund both need approve_deposit_refund.
  const canRequest = Boolean(user);
  const canApprove = canDo(user, "approve_deposit_refund");
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const anyFilter = filters.status !== "" || filters.assetTypeId !== "" || filters.source !== "" || filters.refundOverdue || filters.movedOnly;
  const t = report?.totals;
  const rec = report?.reconciliation;

  return (
    <ConsoleShell>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Deposit</h1>
          <p className="mt-1 text-sm text-brand-700/60">Uang jaminan yang diterima, dipotong untuk kerusakan, diminta kembali, dan direfund.</p>
        </div>
        <button
          onClick={download}
          disabled={!report || downloading}
          className="rounded border border-brand-600/20 bg-white px-3 py-1.5 text-sm font-medium hover:bg-brand-700/5 disabled:opacity-50"
        >
          {downloading ? "Mengunduh…" : "Unduh CSV"}
        </button>
      </div>

      <div className="mt-4">{range && <ReportRange value={range} onChange={setRange} timeZone={timeZone} />}</div>
      <p className="mt-2 text-xs text-brand-700/60">
        Rentang berlaku untuk tanggal pergerakan deposit. Daftar di bawah berisi deposit yang masih ditahan pada akhir rentang dan deposit yang bergerak di dalam rentang.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3 text-sm" data-testid="deposit-filters">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-brand-700/60">Status</span>
          <select value={filters.status} onChange={(e) => set("status", e.target.value as Filters["status"])} className="rounded border border-brand-600/20 bg-white px-2 py-1.5">
            <option value="">Semua status</option>
            {(Object.keys(STATUS_LABELS) as DepositStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-brand-700/60">Tipe unit</span>
          <select value={filters.assetTypeId} onChange={(e) => set("assetTypeId", e.target.value)} className="rounded border border-brand-600/20 bg-white px-2 py-1.5">
            <option value="">Semua tipe unit</option>
            {report?.unitTypes.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-brand-700/60">Sumber</span>
          <select value={filters.source} onChange={(e) => set("source", e.target.value as Filters["source"])} className="rounded border border-brand-600/20 bg-white px-2 py-1.5">
            <option value="">Semua sumber</option>
            <option value="RENTOS">RentOS</option>
            <option value="LEGACY">Booqable (impor)</option>
          </select>
        </label>
        <label className="flex items-center gap-2 pb-1.5">
          <input type="checkbox" checked={filters.refundOverdue} onChange={(e) => set("refundOverdue", e.target.checked)} />
          <span>Refund terlambat</span>
        </label>
        <label className="flex items-center gap-2 pb-1.5">
          <input type="checkbox" checked={filters.movedOnly} onChange={(e) => set("movedOnly", e.target.checked)} />
          <span>Hanya yang bergerak dalam rentang</span>
        </label>
        {anyFilter && (
          <button onClick={() => setFilters(NO_FILTERS)} className="pb-1.5 text-sm text-brand-700/70 underline">
            Hapus filter
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm text-red-600">
          {error}
        </p>
      )}

      {t && rec && report && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="deposit-totals">
            <Tile label="Ditahan pada akhir rentang" value={formatIDR(t.heldAtEnd)} hint={`Awal rentang: ${formatIDR(t.heldAtStart)}`} />
            <Tile label="Diterima dalam rentang" value={formatIDR(t.receivedInRange)} />
            <Tile label="Dipotong dalam rentang" value={formatIDR(t.appliedInRange)} />
            <Tile label="Direfund dalam rentang" value={formatIDR(t.refundedInRange)} />
            <Tile
              label="Refund terlambat"
              value={`${t.refundsOverdueCount} deposit`}
              hint={formatIDR(t.refundsOverdueAmount)}
              tone={t.refundsOverdueCount > 0 ? "warn" : undefined}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-brand-700/60">
            <span>{t.depositCount} deposit</span>
            {report.filtered && <span>Angka di atas mengikuti filter.</span>}
            {Number(t.adjustedInRange) !== 0 && <span>Koreksi impor Booqable dalam rentang: {formatIDR(t.adjustedInRange)}</span>}
            {rec.matches ? (
              <span data-testid="deposit-reconciled" className="rounded-full bg-green-100 px-2 py-0.5 text-green-800">
                Cocok dengan buku besar: {formatIDR(rec.ledgerBalance)}
              </span>
            ) : (
              <span data-testid="deposit-mismatch" role="alert" className="rounded-full bg-red-600 px-2 py-0.5 font-medium text-white">
                Tidak cocok dengan buku besar — catatan deposit {formatIDR(rec.heldAtEnd)}, buku besar {formatIDR(rec.ledgerBalance)}, selisih {formatIDR(rec.difference)}
              </span>
            )}
          </div>
        </>
      )}

      {!report ? (
        <p className="mt-6">{error ? "" : "Memuat…"}</p>
      ) : report.rows.length === 0 ? (
        <p className="mt-6 text-brand-700/60">{anyFilter ? "Tidak ada deposit yang cocok dengan filter ini." : "Tidak ada deposit dalam rentang ini."}</p>
      ) : (
        <div className={`mt-4 overflow-x-auto rounded-lg border border-brand-600/10 bg-white ${loading ? "opacity-60" : ""}`}>
          <table className="w-full min-w-[1180px] text-sm">
            <thead className="bg-brand-700/5 text-left text-xs">
              <tr>
                <th className="p-2.5">Pelanggan</th>
                <th className="p-2.5">No. kontrak</th>
                <th className="p-2.5">Unit</th>
                <th className="p-2.5 text-right">Jumlah</th>
                <th className="p-2.5">Tgl. diterima</th>
                <th className="p-2.5 text-right">Dipotong</th>
                <th className="p-2.5 text-right">Sisa</th>
                <th className="p-2.5">Status</th>
                <th className="p-2.5">Akhir sewa</th>
                <th className="p-2.5">Jatuh tempo refund</th>
                <th className="p-2.5">Tgl. refund</th>
                <th className="p-2.5">Ref. pembayaran</th>
                <th className="p-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((d) => {
                const remaining = Number(d.remaining);
                const open = d.status === "HELD" || d.status === "PARTIALLY_APPLIED";
                const canApply = open && canApprove;
                const canRequestThis = open && remaining > 0 && canRequest;
                const heldDiffers = Math.abs(Number(d.heldAtEnd) - remaining) >= 0.005;
                return (
                  <Fragment key={d.id}>
                    <tr className="border-t border-brand-600/10 align-top">
                      <td className="p-2.5">
                        {d.customerId ? (
                          <Link href={`/clients/${d.customerId}`} className="font-medium hover:underline">
                            {d.customerName}
                          </Link>
                        ) : (
                          <span className="font-medium">{d.customerName}</span>
                        )}
                        <div className="text-xs text-brand-700/60">
                          {d.customerNumber !== null ? `No. ${d.customerNumber}` : "Belum bernomor"}
                          {d.source === "LEGACY" && <span className="ml-1.5 rounded bg-brand-700/10 px-1.5 py-0.5">{SOURCE_LABELS.LEGACY}</span>}
                        </div>
                      </td>
                      <td className="p-2.5">
                        <Link href={`/bookings/${d.bookingId}`} className="hover:underline">
                          {d.contractNumber ?? "—"}
                        </Link>
                      </td>
                      <td className="p-2.5">
                        {d.unitCode ?? "—"}
                        <div className="text-xs text-brand-700/60">{d.unitTypeName}</div>
                      </td>
                      <td className="p-2.5 text-right">{formatIDR(d.amount)}</td>
                      <td className="p-2.5">{formatInstant(d.receivedAt, report.timeZone)}</td>
                      <td className="p-2.5 text-right">{Number(d.appliedAmount) > 0 ? formatIDR(d.appliedAmount) : "—"}</td>
                      <td className="p-2.5 text-right">
                        {formatIDR(d.remaining)}
                        {heldDiffers && <div className="text-xs text-brand-700/60">Akhir rentang: {formatIDR(d.heldAtEnd)}</div>}
                      </td>
                      <td className="p-2.5">
                        <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_COLORS[d.status]}`}>{STATUS_LABELS[d.status]}</span>
                        {d.status === "REFUND_REQUESTED" && d.refundRequestedAt && (
                          <div className="mt-1 text-xs text-brand-700/60">Diminta {formatInstant(d.refundRequestedAt, report.timeZone)}</div>
                        )}
                      </td>
                      <td className="p-2.5">{formatCalendarDate(d.leaseEnd)}</td>
                      <td className="p-2.5">
                        {formatCalendarDate(d.refundDue)}
                        {d.refundOverdue && <div className="mt-0.5 inline-block rounded bg-red-600 px-1.5 py-0.5 text-xs font-medium text-white">Terlambat</div>}
                      </td>
                      <td className="p-2.5">{formatInstant(d.refundedAt, report.timeZone)}</td>
                      <td className="max-w-[10rem] break-all p-2.5 text-xs">{d.payoutRef ?? "—"}</td>
                      <td className="p-2.5 text-right">
                        <div className="flex flex-col items-end gap-1.5">
                          {canApply && (
                            <button
                              onClick={() => setApplyingId(applyingId === d.id ? null : d.id)}
                              className="whitespace-nowrap rounded border border-brand-600/20 px-2.5 py-1 text-xs font-medium hover:bg-brand-700/5"
                            >
                              Potong untuk kerusakan
                            </button>
                          )}
                          {canRequestThis && (
                            <button
                              onClick={() => act(d.id, "request-refund", null, "Gagal meminta refund.")}
                              disabled={busyId === d.id}
                              className="whitespace-nowrap rounded border border-brand-600/20 px-2.5 py-1 text-xs font-medium hover:bg-brand-700/5 disabled:opacity-50"
                            >
                              Minta refund
                            </button>
                          )}
                          {d.status === "REFUND_REQUESTED" && canApprove && (
                            <button
                              onClick={() => act(d.id, "approve-refund", null, "Gagal menyetujui refund.")}
                              disabled={busyId === d.id}
                              className="whitespace-nowrap rounded bg-brand-700 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                            >
                              Setujui refund ({formatIDR(d.remaining)})
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {applyingId === d.id && (
                      <tr className="border-t border-brand-600/10 bg-brand-700/5">
                        <td colSpan={13} className="p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              value={applyAmount}
                              onChange={(e) => setApplyAmount(e.target.value)}
                              placeholder={`Jumlah (maks. ${remaining})`}
                              aria-label="Jumlah yang dipotong"
                              className="w-44 rounded border border-brand-600/20 px-2 py-1 text-sm"
                            />
                            <input
                              value={applyReason}
                              onChange={(e) => setApplyReason(e.target.value)}
                              placeholder="Alasan (mis. gembok rusak, biaya kebersihan)"
                              aria-label="Alasan pemotongan"
                              className="min-w-[16rem] flex-1 rounded border border-brand-600/20 px-2 py-1 text-sm"
                            />
                            <button
                              onClick={() => applyToDamages(d.id)}
                              disabled={busyId === d.id || !applyAmount || !applyReason}
                              className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                            >
                              Konfirmasi
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleShell>
  );
}

// useReportRange reads the URL (useSearchParams), which Next requires to sit under a Suspense boundary.
export default function DepositsPage() {
  return (
    <Suspense fallback={null}>
      <DepositsReport />
    </Suspense>
  );
}
