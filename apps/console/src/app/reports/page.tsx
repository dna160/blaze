"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { ClientList } from "@/components/ClientList";
import { ConsoleShell } from "@/components/ConsoleShell";
import { rangeQuery, ReportRange, useReportRange, type ReportRangeValue } from "@/components/ReportRange";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { canDo } from "@/lib/capabilities";

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

const TABS = [
  { id: "penjualan", label: "Penjualan" },
  { id: "ringkasan", label: "Ringkasan keuangan" },
  { id: "piutang", label: "Umur piutang" },
  { id: "ekspor", label: "Ekspor data" },
  { id: "pelanggan", label: "Pelanggan" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const TIME_ZONE = "Asia/Jakarta";

function ExportsSection({ range }: { range: ReportRangeValue }) {
  const q = rangeQuery(range);
  const files: Array<{ kind: string; title: string; hint: string }> = [
    { kind: "invoices", title: "Invoice", hint: "Semua invoice menurut tanggal terbit, dengan nomor kontrak, unit dan deposit." },
    { kind: "payments", title: "Pembayaran", hint: "Semua pembayaran menurut tanggal bayar, termasuk yang menunggu verifikasi dan yang gagal." },
    { kind: "ledger", title: "Buku besar", hint: "Setiap catatan debit dan kredit dalam rentang." },
    { kind: "contracts", title: "Kontrak", hint: "Kontrak yang dibuat dalam rentang, dengan pelanggan, unit dan status tanda tangan." },
  ];
  return (
    <section data-testid="exports-section">
      <SectionHeader
        title="Ekspor data"
        hint="Berkas CSV untuk rentang yang dipilih. Nominal dalam rupiah tanpa pemisah ribuan, tanggal dan jam dalam WIB; bisa dibuka langsung di Google Sheets dan Excel."
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
      <p className="mt-3 text-xs text-brand-700/60">
        Laporan penjualan, ringkasan keuangan, umur piutang dan daftar pelanggan punya tombol unduh sendiri di tab masing-masing. Laporan deposit ada di halaman Deposit.
      </p>
    </section>
  );
}

function ReportsContent() {
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
  const tab: TabId = TABS.some((t) => t.id === requested) ? (requested as TabId) : "penjualan";
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
        else setError(err instanceof ApiError ? err.message : "Laporan gagal dimuat.");
      });
  }, [allowed, router]);

  if (sessionRead && !allowed) {
    return (
      <>
        <h1 className="text-2xl font-semibold">Laporan</h1>
        <p className="mt-4 rounded border border-brand-600/10 bg-white p-4 text-sm text-brand-700/80" data-testid="reports-no-access">
          Akun Anda tidak memiliki akses ke laporan keuangan. Laporan hanya untuk Admin dan Finance.
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold">Laporan</h1>

      <div className="mt-4">{range && <ReportRange value={range} onChange={setRange} timeZone={TIME_ZONE} locale="id" />}</div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Tile
          label="Okupansi saat ini"
          value={occupancy ? `${Math.round(occupancy.occupancyRate * 100)}%` : "—"}
          sub={occupancy ? `${occupancy.occupiedAssets} dari ${occupancy.totalAssets} unit terisi` : undefined}
        />
        <Tile label="Sewa aktif saat ini" value={funnel?.active ?? "—"} sub={funnel ? `${funnel.requested} permintaan · ${funnel.approved} disetujui` : undefined} />
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-6 flex flex-wrap gap-1 border-b border-brand-600/15" role="tablist" aria-label="Bagian laporan">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => selectTab(t.id)}
            className={`-mb-px rounded-t border border-b-0 px-4 py-2 text-sm font-medium ${tab === t.id ? "border-brand-600/15 bg-white text-brand-700" : "border-transparent text-brand-700/60 hover:text-brand-700"}`}
          >
            {t.label}
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
              title="Pelanggan"
              hint="Siapa menyewa apa, sejak kapan, dan apakah sehat (sudah bayar), berisiko (jatuh tempo dalam 7 hari), terlambat, atau tidak aktif. Klik pelanggan untuk rinciannya."
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
  return (
    <ConsoleShell>
      {/* useSearchParams needs a Suspense boundary to build. */}
      <Suspense fallback={<h1 className="text-2xl font-semibold">Laporan</h1>}>
        <ReportsContent />
      </Suspense>
    </ConsoleShell>
  );
}
