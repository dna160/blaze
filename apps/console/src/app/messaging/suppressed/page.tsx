"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import type { SuppressedMessagesResponse, SuppressionCodeName } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { rangeQuery, ReportRange, useReportRange } from "@/components/ReportRange";
import { apiDownload, apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

/**
 * PRD go-live 2 §8.2 — the messages that were held back instead of sent:
 * while messaging was paused, or (in test mode) because the recipient is not
 * one of the test numbers. A review list only — nothing here is ever sent, and
 * unpausing or turning test mode off does not replay it.
 */

const REASON_LABEL: Record<SuppressionCodeName, string> = {
  PAUSED: "Pengiriman dijeda",
  NOT_ON_TEST_ALLOWLIST: "Bukan nomor uji",
  UNKNOWN_TENANT: "Cabang tidak dikenal",
};

const REASON_TONE: Record<SuppressionCodeName, string> = {
  PAUSED: "bg-red-100 text-red-800",
  NOT_ON_TEST_ALLOWLIST: "bg-amber-100 text-amber-900",
  UNKNOWN_TENANT: "bg-slate-200 text-slate-700",
};

const PAGE_SIZE = 50;

function SuppressedMessages() {
  const router = useRouter();
  const user = authClient.getUser();
  const { range, setRange, timeZone } = useReportRange({ userId: user?.id });
  const [template, setTemplate] = useState("");
  const [reason, setReason] = useState<"" | SuppressionCodeName>("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<SuppressedMessagesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!authClient.getToken()) router.replace("/login");
  }, [router]);

  const filters = range ? `${rangeQuery(range)}${template ? `&template=${encodeURIComponent(template)}` : ""}${reason ? `&reason=${reason}` : ""}` : null;

  useEffect(() => {
    setPage(1);
  }, [filters]);

  useEffect(() => {
    if (!filters) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<SuppressedMessagesResponse>(`/organization/messaging/suppressed?${filters}&page=${page}&pageSize=${PAGE_SIZE}`, { token: authClient.getToken() })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Daftar pesan yang ditahan tidak dapat dimuat.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters, page]);

  async function download() {
    if (!filters || !range) return;
    setDownloading(true);
    try {
      await apiDownload(`/organization/messaging/suppressed.csv?${filters}`, authClient.getToken(), `pesan-ditahan_${range.from}_${range.to}.csv`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gagal mengunduh CSV.");
    } finally {
      setDownloading(false);
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const when = (iso: string) =>
    new Date(iso).toLocaleString("id-ID", { timeZone: data?.timeZone ?? timeZone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Pesan yang ditahan</h1>
          <p className="mt-1 max-w-3xl text-sm text-brand-700/70">
            Pesan yang tidak dikirim karena pengiriman sedang dijeda, atau karena penerimanya bukan nomor uji. Daftar ini hanya untuk diperiksa:
            tidak ada pesan di sini yang dikirim ulang secara otomatis, juga setelah jeda dibuka atau mode uji dimatikan.
          </p>
        </div>
        <Link href="/settings/messaging" className="text-sm text-brand-700 underline">
          Pengaturan pesan
        </Link>
      </div>

      {range && <ReportRange value={range} onChange={setRange} timeZone={timeZone} />}

      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-brand-700/60">Templat</span>
          <select value={template} onChange={(e) => setTemplate(e.target.value)} className="rounded border border-brand-600/20 bg-white px-2 py-1.5">
            <option value="">Semua templat</option>
            {(data?.templates ?? []).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-brand-700/60">Alasan</span>
          <select value={reason} onChange={(e) => setReason(e.target.value as "" | SuppressionCodeName)} className="rounded border border-brand-600/20 bg-white px-2 py-1.5">
            <option value="">Semua alasan</option>
            <option value="PAUSED">Pengiriman dijeda</option>
            <option value="NOT_ON_TEST_ALLOWLIST">Bukan nomor uji</option>
          </select>
        </label>
        <button type="button" onClick={() => void download()} disabled={downloading || !data || data.total === 0} className="rounded border border-brand-700 px-3 py-1.5 font-medium text-brand-700 disabled:opacity-40">
          {downloading ? "Mengunduh…" : "Unduh CSV"}
        </button>
        {data && (
          <span className="pb-1.5 text-xs text-brand-700/60" data-testid="suppressed-count">
            {data.total} pesan dalam rentang ini · {data.totalEver} seluruhnya
          </span>
        )}
      </div>

      {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="overflow-x-auto rounded border border-brand-600/10 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-brand-700/5 text-xs uppercase tracking-wide text-brand-700/70">
            <tr>
              <th className="px-3 py-2">Dibuat</th>
              <th className="px-3 py-2">Templat</th>
              <th className="px-3 py-2">Penerima</th>
              <th className="px-3 py-2">Pelanggan</th>
              <th className="px-3 py-2">Alasan</th>
              <th className="px-3 py-2">Cabang</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((m) => (
              <tr key={m.id} className="border-t border-brand-600/10">
                <td className="whitespace-nowrap px-3 py-2">{when(m.createdAt)}</td>
                <td className="px-3 py-2 font-mono text-xs">{m.templateKey}</td>
                <td className="px-3 py-2">
                  {m.recipient}
                  {m.recipientRole === "ADMIN" && <span className="ml-1 rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700">staf</span>}
                  {m.channel === "EMAIL" && <span className="ml-1 rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700">email</span>}
                </td>
                <td className="px-3 py-2">
                  {m.customerId ? (
                    <Link href={`/clients/${m.customerId}`} className="text-brand-700 underline">
                      {m.customerName ?? "Pelanggan"}
                      {m.customerNumber !== null ? ` · #${m.customerNumber}` : ""}
                    </Link>
                  ) : (
                    <span className="text-brand-700/50">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${REASON_TONE[m.reason]}`} title={m.reasonText ?? undefined}>
                    {REASON_LABEL[m.reason]}
                  </span>
                </td>
                <td className="px-3 py-2 text-brand-700/70">{m.branchName ?? "—"}</td>
              </tr>
            ))}
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-brand-700/60">
                  {loading ? "Memuat…" : "Tidak ada pesan yang ditahan dalam rentang ini."}
                </td>
              </tr>
            )}
            {!data && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-brand-700/60">
                  Memuat…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data && pages > 1 && (
        <div className="flex items-center gap-3 text-sm">
          <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="rounded border border-brand-600/20 px-3 py-1.5 disabled:opacity-40">
            Sebelumnya
          </button>
          <span>
            Halaman {page} dari {pages}
          </span>
          <button type="button" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} className="rounded border border-brand-600/20 px-3 py-1.5 disabled:opacity-40">
            Berikutnya
          </button>
        </div>
      )}
    </div>
  );
}

export default function SuppressedMessagesPage() {
  return (
    <ConsoleShell>
      {/* useSearchParams (the range lives in the URL) needs a Suspense boundary. */}
      <Suspense fallback={<p className="text-sm text-brand-700/60">Memuat…</p>}>
        <SuppressedMessages />
      </Suspense>
    </ConsoleShell>
  );
}
