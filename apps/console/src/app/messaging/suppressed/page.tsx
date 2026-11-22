"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import type { SuppressedMessagesResponse, SuppressionCodeName } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { rangeQuery, ReportRange, useReportRange } from "@/components/ReportRange";
import { apiDownload, apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { tr, useT } from "@/lib/i18n";

/**
 * PRD go-live 2 §8.2 — the messages that were held back instead of sent:
 * while messaging was paused, or (in test mode) because the recipient is not
 * one of the test numbers. A review list only — nothing here is ever sent, and
 * unpausing or turning test mode off does not replay it.
 */

const reasonLabel = (r: SuppressionCodeName) => tr(`suppressed.reason.${r}`);

const REASON_TONE: Record<SuppressionCodeName, string> = {
  PAUSED: "bg-red-100 text-red-800",
  NOT_ON_TEST_ALLOWLIST: "bg-amber-100 text-amber-900",
  UNKNOWN_TENANT: "bg-slate-200 text-slate-700",
};

const PAGE_SIZE = 50;

function SuppressedMessages() {
  const { t, intl } = useT();
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
        if (!cancelled) setError(err instanceof ApiError ? err.message : tr("suppressed.loadFailed"));
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
      await apiDownload(`/organization/messaging/suppressed.csv?${filters}`, authClient.getToken(), `${t("suppressed.fileName")}_${range.from}_${range.to}.csv`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("suppressed.downloadFailed"));
    } finally {
      setDownloading(false);
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const when = (iso: string) =>
    new Date(iso).toLocaleString(intl, { timeZone: data?.timeZone ?? timeZone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("suppressed.title")}</h1>
          <p className="mt-1 max-w-3xl text-sm text-brand-700/70">{t("suppressed.intro")}</p>
        </div>
        <Link href="/settings/messaging" className="text-sm text-brand-700 underline">
          {t("suppressed.settingsLink")}
        </Link>
      </div>

      {range && <ReportRange value={range} onChange={setRange} timeZone={timeZone} />}

      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-brand-700/60">{t("suppressed.template")}</span>
          <select value={template} onChange={(e) => setTemplate(e.target.value)} className="rounded border border-brand-600/20 bg-white px-2 py-1.5">
            <option value="">{t("suppressed.allTemplates")}</option>
            {(data?.templates ?? []).map((tpl) => (
              <option key={tpl} value={tpl}>
                {tpl}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-brand-700/60">{t("common.reason")}</span>
          <select value={reason} onChange={(e) => setReason(e.target.value as "" | SuppressionCodeName)} className="rounded border border-brand-600/20 bg-white px-2 py-1.5">
            <option value="">{t("suppressed.allReasons")}</option>
            <option value="PAUSED">{reasonLabel("PAUSED")}</option>
            <option value="NOT_ON_TEST_ALLOWLIST">{reasonLabel("NOT_ON_TEST_ALLOWLIST")}</option>
          </select>
        </label>
        <button type="button" onClick={() => void download()} disabled={downloading || !data || data.total === 0} className="rounded border border-brand-700 px-3 py-1.5 font-medium text-brand-700 disabled:opacity-40">
          {downloading ? t("common.downloading") : t("common.downloadCsv")}
        </button>
        {data && (
          <span className="pb-1.5 text-xs text-brand-700/60" data-testid="suppressed-count">
            {t("suppressed.count", { total: data.total, ever: data.totalEver })}
          </span>
        )}
      </div>

      {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="overflow-x-auto rounded border border-brand-600/10 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-brand-700/5 text-xs uppercase tracking-wide text-brand-700/70">
            <tr>
              <th className="px-3 py-2">{t("common.createdAt")}</th>
              <th className="px-3 py-2">{t("suppressed.template")}</th>
              <th className="px-3 py-2">{t("suppressed.recipient")}</th>
              <th className="px-3 py-2">{t("common.customer")}</th>
              <th className="px-3 py-2">{t("common.reason")}</th>
              <th className="px-3 py-2">{t("common.branch")}</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((m) => (
              <tr key={m.id} className="border-t border-brand-600/10">
                <td className="whitespace-nowrap px-3 py-2">{when(m.createdAt)}</td>
                <td className="px-3 py-2 font-mono text-xs">{m.templateKey}</td>
                <td className="px-3 py-2">
                  {m.recipient}
                  {m.recipientRole === "ADMIN" && <span className="ml-1 rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700">{t("suppressed.staff")}</span>}
                  {m.channel === "EMAIL" && <span className="ml-1 rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700">{t("suppressed.email")}</span>}
                </td>
                <td className="px-3 py-2">
                  {m.customerId ? (
                    <Link href={`/clients/${m.customerId}`} className="text-brand-700 underline">
                      {m.customerName ?? t("common.customer")}
                      {m.customerNumber !== null ? ` · #${m.customerNumber}` : ""}
                    </Link>
                  ) : (
                    <span className="text-brand-700/50">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${REASON_TONE[m.reason]}`} title={m.reasonText ?? undefined}>
                    {reasonLabel(m.reason)}
                  </span>
                </td>
                <td className="px-3 py-2 text-brand-700/70">{m.branchName ?? "—"}</td>
              </tr>
            ))}
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-brand-700/60">
                  {loading ? t("common.loading") : t("suppressed.empty")}
                </td>
              </tr>
            )}
            {!data && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-brand-700/60">
                  {t("common.loading")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data && pages > 1 && (
        <div className="flex items-center gap-3 text-sm">
          <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="rounded border border-brand-600/20 px-3 py-1.5 disabled:opacity-40">
            {t("common.previous")}
          </button>
          <span>{t("common.pageOf", { page, pages })}</span>
          <button type="button" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} className="rounded border border-brand-600/20 px-3 py-1.5 disabled:opacity-40">
            {t("common.next")}
          </button>
        </div>
      )}
    </div>
  );
}

export default function SuppressedMessagesPage() {
  const { t } = useT();
  return (
    <ConsoleShell>
      {/* useSearchParams (the range lives in the URL) needs a Suspense boundary. */}
      <Suspense fallback={<p className="text-sm text-brand-700/60">{t("common.loading")}</p>}>
        <SuppressedMessages />
      </Suspense>
    </ConsoleShell>
  );
}
