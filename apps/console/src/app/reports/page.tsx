"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { ClientList } from "@/components/ClientList";
import { ConsoleShell } from "@/components/ConsoleShell";
import { rangeQuery, ReportRange, useReportRange, type ReportRangeValue } from "@/components/ReportRange";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { canDo } from "@/lib/capabilities";
import { useT } from "@/lib/i18n";

import { ArAgingSection } from "./ArAgingSection";
import { FinancialSummarySection } from "./FinancialSummarySection";
import { DownloadCsvButton, SectionHeader, Tile } from "./report-ui";
import { SalesSection } from "./SalesSection";

/**
 * Reports (PRD §7.2.6, PRD go-live 2 §2). One date-range control at the top;
 * every section below reads from it, and the range lives in the URL so a
 * report can be bookmarked and shared.
 */

interface Occupancy {
  totalAssets: number;
  occupiedAssets: number;
  occupancyRate: number;
}
interface BookingFunnel {
  requested: number;
  approved: number;
  active: number;
}

/** Tab ids stay Indonesian (they are in shared URLs); labels are `reports.tabs.<id>`. */
const TABS = [{ id: "penjualan" }, { id: "ringkasan" }, { id: "piutang" }, { id: "ekspor" }, { id: "pelanggan" }] as const;
type TabId = (typeof TABS)[number]["id"];

const TIME_ZONE = "Asia/Jakarta";

function ExportsSection({ range }: { range: ReportRangeValue }) {
  const { t } = useT();
  const q = rangeQuery(range);
  const files = ["invoices", "payments", "ledger", "contracts"].map((kind) => ({
    kind,
    title: t(`reports.exports.${kind}`),
    hint: t(`reports.exports.${kind}Hint`),
  }));
  return (
    <section data-testid="exports-section">
      <SectionHeader
        title={t("reports.exports.title")}
        hint={t("reports.exports.hint")}
      />
      <ul className="mt-4 divide-y divide-brand-600/10 rounded-lg border border-brand-600/10 bg-white">
        {files.map((f) => (
          <li key={f.kind} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="font-medium">{f.title}</p>
              <p className="text-sm text-brand-700/60">{f.hint}</p>
            </div>
            <DownloadCsvButton path={`/reports/export/${f.kind}.csv?${q}`} fallbackName={`${f.kind}.csv`} />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-brand-700/60">{t("reports.exports.footer")}</p>
    </section>
  );
}

function ReportsContent() {
  const { t, locale } = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  // The session lives in localStorage, which the server render cannot see.
  const [user, setUser] = useState<ReturnType<typeof authClient.getUser>>(null);
  const [sessionRead, setSessionRead] = useState(false);
  useEffect(() => {
    if (!authClient.getToken()) {
      router.push("/login");
      return;
    }
    setUser(authClient.getUser());
    setSessionRead(true);
  }, [router]);
  const allowed = canDo(user, "run_reports");

  const { range, setRange } = useReportRange({ timeZone: TIME_ZONE, userId: user?.id ?? null });
  // The URL always carries the range in use (§2.1), also when it came from the
  // remembered one or the default — so a copied link opens the same report.
  useEffect(() => {
    if (!range || (params?.get("from") === range.from && params?.get("to") === range.to)) return;
    const q = new URLSearchParams(params?.toString() ?? "");
    q.set("from", range.from);
    q.set("to", range.to);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  }, [range, params, pathname, router]);

  const requested = params?.get("tab");
  const tab: TabId = TABS.some((x) => x.id === requested) ? (requested as TabId) : "penjualan";
  function selectTab(next: TabId) {
    const q = new URLSearchParams(params?.toString() ?? "");
    q.set("tab", next);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  }

  const [occupancy, setOccupancy] = useState<Occupancy | null>(null);
  const [funnel, setFunnel] = useState<BookingFunnel | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!allowed) return;
    const token = authClient.getToken();
    Promise.all([apiFetch<Occupancy>("/reports/occupancy", { token }), apiFetch<BookingFunnel>("/reports/booking-funnel", { token })])
      .then(([o, f]) => {
        setOccupancy(o);
        setFunnel(f);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.push("/login");
        else setError(err instanceof ApiError ? err.message : t("reports.loadFailed"));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t only changes the fallback text
  }, [allowed, router]);

  if (sessionRead && !allowed) {
    return (
      <>
        <h1 className="text-2xl font-semibold">{t("reports.title")}</h1>
        <p className="mt-4 rounded border border-brand-600/10 bg-white p-4 text-sm text-brand-700/80" data-testid="reports-no-access">
          {t("reports.noAccess")}
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold">{t("reports.title")}</h1>

      <div className="mt-4">{range && <ReportRange value={range} onChange={setRange} timeZone={TIME_ZONE} locale={locale} />}</div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Tile
          label={t("reports.occupancyNow")}
          value={occupancy ? `${Math.round(occupancy.occupancyRate * 100)}%` : "—"}
          sub={occupancy ? t("reports.occupancySub", { occupied: occupancy.occupiedAssets, total: occupancy.totalAssets }) : undefined}
        />
        <Tile label={t("reports.activeNow")} value={funnel?.active ?? "—"} sub={funnel ? t("reports.funnelSub", { requested: funnel.requested, approved: funnel.approved }) : undefined} />
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-6 flex flex-wrap gap-1 border-b border-brand-600/15" role="tablist" aria-label={t("reports.tabsLabel")}>
        {TABS.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => selectTab(x.id)}
            className={`-mb-px rounded-t border border-b-0 px-4 py-2 text-sm font-medium ${tab === x.id ? "border-brand-600/15 bg-white text-brand-700" : "border-transparent text-brand-700/60 hover:text-brand-700"}`}
          >
            {t(`reports.tabs.${x.id}`)}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {range && tab === "penjualan" && <SalesSection range={range} />}
        {range && tab === "ringkasan" && <FinancialSummarySection range={range} />}
        {range && tab === "piutang" && <ArAgingSection range={range} timeZone={TIME_ZONE} />}
        {range && tab === "ekspor" && <ExportsSection range={range} />}
        {tab === "pelanggan" && (
          <section data-testid="clients-section">
            <SectionHeader
              title={t("reports.clients.title")}
              hint={t("reports.clients.hint")}
              action={<DownloadCsvButton path="/reports/export/clients.csv" fallbackName="clients.csv" />}
            />
            <div className="mt-3">
              <ClientList compact />
            </div>
          </section>
        )}
      </div>
    </>
  );
}

export default function ReportsPage() {
  const { t } = useT();
  return (
    <ConsoleShell>
      {/* useSearchParams needs a Suspense boundary to build. */}
      <Suspense fallback={<h1 className="text-2xl font-semibold">{t("reports.title")}</h1>}>
        <ReportsContent />
      </Suspense>
    </ConsoleShell>
  );
}
