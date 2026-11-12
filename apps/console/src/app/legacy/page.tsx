"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { LegacyRecordDetail, LegacyRecordListItem } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

/**
 * The legacy archive (owner, 2026-11-12): everything the previous system
 * (Booqable) held, kept as it made it. Read-only — these records are history
 * and never change RentOS's invoices, payments or accounts. Contracts made
 * from go-live on are RentOS documents; the ones here are the backlog.
 */

const TABS: Array<{ kind: string; label: string }> = [
  { kind: "CONTRACT", label: "Contracts" },
  { kind: "INVOICE", label: "Invoices" },
  { kind: "PAYMENT", label: "Payments" },
  { kind: "ORDER", label: "Orders" },
  { kind: "CUSTOMER", label: "Customers" },
  { kind: "NOTE", label: "Notes" },
  { kind: "QUOTE", label: "Quotes" },
  { kind: "EMAIL", label: "Emails" },
  { kind: "CONFIG", label: "Settings" },
];

interface Summary {
  kind: string;
  count: number;
  amount: string | null;
}
interface Line {
  title: string | null;
  line_type: string | null;
  quantity: number | null;
  price_each_in_cents: number | null;
  price_in_cents: number | null;
  charge_label: string | null;
}

function idr(amount: string | number | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}
function cents(v: unknown): string {
  return typeof v === "number" ? idr(v / 100) : "—";
}
function day(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" }) : "—";
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** The contract exactly as Booqable held it: its header, lines, text and the customer's signature. */
function contractHtml(r: LegacyRecordDetail): string {
  const d = r.data as Record<string, unknown>;
  const lines = ((d.lines as Line[]) ?? []).filter((l) => l.line_type === "charge");
  const rows = lines
    .map((l) => `<tr><td>${esc(String(l.quantity ?? 1))}x ${esc(l.title ?? "")}</td><td>${esc(l.charge_label ?? "")}</td><td style="text-align:right">${esc(cents(l.price_in_cents))}</td></tr>`)
    .join("");
  const sig = typeof d.signatureImage === "string" ? `<p><b>Signature</b></p><img src="${esc(d.signatureImage)}" style="max-width:260px;border-bottom:1px solid #000" />` : "<p><i>No signature on file.</i></p>";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#111;margin:24px}
    table{border-collapse:collapse;width:100%} td{vertical-align:top;padding:3px 6px}
    .head td{padding:2px 0}.lines td{border-bottom:1px solid #ddd}
  </style></head><body>
    <h2>${esc(r.title ?? "")}</h2>
    <table class="head"><tr><td><b>${esc(String(d.name ?? r.customerName ?? ""))}</b><br>${esc(String(d.address ?? "")).replace(/\n/g, "<br>")}</td>
    <td style="text-align:right">Date ${esc(String(d.date ?? "—"))}<br>Order #${esc(String(d.orderNumber ?? "—"))}<br>From ${esc(day(d.starts_at as string))}<br>Until ${esc(day(d.stops_at as string))}<br>Units ${esc(((d.units as string[]) ?? []).join(", "))}</td></tr></table>
    <br><table class="lines">${rows}</table>
    <p style="text-align:right">Total <b>${esc(cents(d.grand_total_with_tax_in_cents))}</b> · Security deposit ${esc(cents(d.deposit_in_cents))}</p>
    <hr>${r.bodyHtml ?? ""}${r.footerHtml ?? ""}<hr>${sig}
  </body></html>`;
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const [record, setRecord] = useState<LegacyRecordDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  useEffect(() => {
    setRecord(null);
    apiFetch<LegacyRecordDetail>(`/legacy/records/${id}`, { token: authClient.getToken() })
      .then(setRecord)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load the record."));
  }, [id]);

  const d = (record?.data ?? {}) as Record<string, unknown>;
  const lines = ((d.lines as Line[]) ?? []).filter((l) => l.line_type === "charge");
  const isDocument = record?.kind === "CONTRACT" || record?.kind === "INVOICE" || record?.kind === "QUOTE";
  const raw = useMemo(() => {
    if (!record) return "";
    const { signatureImage: _s, ...rest } = d as { signatureImage?: unknown };
    return JSON.stringify(rest, null, 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-3xl overflow-y-auto bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Legacy record · {record?.source ?? "…"} · read-only</p>
            <h2 className="text-xl font-semibold">{record?.title ?? "Loading…"}</h2>
          </div>
          <button onClick={onClose} className="rounded border border-brand-600/20 px-3 py-1 text-sm">
            Close
          </button>
        </div>
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
        {record && (
          <div className="mt-4 space-y-4 text-sm">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1">
              <dt className="text-brand-700/60">Customer</dt>
              <dd>
                {record.customerId ? (
                  <Link href={`/clients/${record.customerId}`} className="underline">
                    {record.customerName} (#{record.customerNumber})
                  </Link>
                ) : (
                  <>
                    {record.customerName ?? "—"}
                    {record.customerNumber ? ` (#${record.customerNumber}, not in RentOS)` : ""}
                  </>
                )}
              </dd>
              <dt className="text-brand-700/60">Number</dt>
              <dd>{record.number ?? "—"}</dd>
              <dt className="text-brand-700/60">Date</dt>
              <dd>{day(record.occurredAt)}</dd>
              <dt className="text-brand-700/60">Status</dt>
              <dd>{record.status ?? "—"}</dd>
              <dt className="text-brand-700/60">Amount</dt>
              <dd>{idr(record.amount)}</dd>
              {isDocument && (
                <>
                  <dt className="text-brand-700/60">Paid / still to pay</dt>
                  <dd>
                    {cents(d.paid_in_cents)} / {cents(d.to_be_paid_in_cents)}
                  </dd>
                  <dt className="text-brand-700/60">Deposit</dt>
                  <dd>{cents(d.deposit_in_cents)}</dd>
                </>
              )}
              {Array.isArray(d.units) && d.units.length > 0 && (
                <>
                  <dt className="text-brand-700/60">Units</dt>
                  <dd>{(d.units as Array<string | { unit: string }>).map((u) => (typeof u === "string" ? u : u.unit)).filter((v, i, a) => a.indexOf(v) === i).join(", ")}</dd>
                </>
              )}
            </dl>

            {lines.length > 0 && (
              <table className="w-full text-left">
                <thead className="text-xs uppercase text-brand-700/50">
                  <tr>
                    <th className="py-1">Line</th>
                    <th>Period</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i} className="border-t border-brand-600/10">
                      <td className="py-1">
                        {l.quantity ?? 1}x {l.title}
                      </td>
                      <td>{l.charge_label ?? ""}</td>
                      <td className="text-right">{cents(l.price_in_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {Array.isArray(d.notes) && d.notes.length > 0 && (
              <div>
                <p className="font-medium">Notes</p>
                {(d.notes as Array<{ body: string; created_at: string }>).map((n, i) => (
                  <p key={i} className="text-brand-700/80">
                    {day(n.created_at)} — {n.body}
                  </p>
                ))}
              </div>
            )}

            {record.kind === "CONTRACT" && (
              <div>
                <p className="mb-1 font-medium">The contract as it was made</p>
                {/* sandbox with no allowances: the stored HTML can never run script or reach the console's session */}
                <iframe title="Legacy contract" sandbox="" srcDoc={contractHtml(record)} className="h-[70vh] w-full rounded border border-brand-600/20 bg-white" />
              </div>
            )}

            <button onClick={() => setShowRaw((v) => !v)} className="text-xs underline">
              {showRaw ? "Hide" : "Show"} every field as exported
            </button>
            {showRaw && <pre className="max-h-96 overflow-auto rounded bg-slate-50 p-3 text-xs">{raw}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}

function LegacyArchive() {
  const router = useRouter();
  const params = useSearchParams();
  const customerNumber = params.get("customer");
  const [summary, setSummary] = useState<Summary[] | null>(null);
  const [kind, setKind] = useState(params.get("kind") ?? "CONTRACT");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<{ total: number; items: LegacyRecordListItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) return router.push("/login");
    apiFetch<Summary[]>(`/legacy/summary${customerNumber ? `?customerNumber=${customerNumber}` : ""}`, { token })
      .then(setSummary)
      .catch((e) => (e instanceof ApiError && e.status === 401 ? router.push("/login") : setError("Could not load the archive.")));
  }, [router, customerNumber]);

  useEffect(() => {
    const token = authClient.getToken();
    if (!token) return;
    const q = new URLSearchParams({ kind, page: String(page), pageSize: "50" });
    if (customerNumber) q.set("customerNumber", customerNumber);
    if (search.trim()) q.set("search", search.trim());
    const t = window.setTimeout(() => {
      apiFetch<{ total: number; items: LegacyRecordListItem[] }>(`/legacy/records?${q}`, { token })
        .then(setList)
        .catch(() => setError("Could not load the records."));
    }, 200);
    return () => window.clearTimeout(t);
  }, [kind, page, search, customerNumber]);

  const count = (k: string) => summary?.find((s) => s.kind === k)?.count ?? 0;
  const pages = list ? Math.max(1, Math.ceil(list.total / 50)) : 1;

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">Legacy records</h1>
      <p className="mt-1 max-w-3xl text-sm text-brand-700/60">
        Everything from the previous system (Booqable), kept as it was made: past and current orders, invoices, payments, contracts with their
        signatures, and notes. Read-only history — it does not change RentOS invoices, payments or accounts.
        {customerNumber && (
          <>
            {" "}
            Showing customer <b>#{customerNumber}</b>.{" "}
            <Link href="/legacy" className="underline">
              Show everyone
            </Link>
          </>
        )}
      </p>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      {summary && summary.length === 0 && <p className="mt-6 text-sm text-brand-700/60">No legacy records have been imported.</p>}

      <div className="mt-6 flex flex-wrap gap-2">
        {TABS.filter((t) => count(t.kind) > 0).map((t) => (
          <button
            key={t.kind}
            onClick={() => {
              setKind(t.kind);
              setPage(1);
            }}
            className={`rounded-full px-3 py-1 text-sm ${kind === t.kind ? "bg-brand-700 text-white" : "border border-brand-600/20 hover:bg-brand-700/5"}`}
          >
            {t.label} <span className="opacity-70">{count(t.kind)}</span>
          </button>
        ))}
      </div>

      <input
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
        placeholder="Search number, customer or text"
        className="mt-4 w-full max-w-md rounded border border-brand-600/20 px-3 py-2 text-sm"
      />

      <div className="mt-4 overflow-x-auto rounded-lg border border-brand-600/10 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-brand-700/50">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th>Number</th>
              <th>Record</th>
              <th>Customer</th>
              <th>Status</th>
              <th className="px-3 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {list?.items.map((r) => (
              <tr key={r.id} onClick={() => setOpenId(r.id)} className="cursor-pointer border-t border-brand-600/10 hover:bg-brand-700/5">
                <td className="whitespace-nowrap px-3 py-2">{day(r.occurredAt)}</td>
                <td className="whitespace-nowrap font-mono text-xs">{r.number ?? "—"}</td>
                <td className="max-w-xs truncate">{r.title}</td>
                <td className="max-w-[14rem] truncate">
                  {r.customerName ?? "—"}
                  {r.customerNumber ? <span className="text-brand-700/50"> #{r.customerNumber}</span> : null}
                </td>
                <td>{r.status ?? ""}</td>
                <td className="whitespace-nowrap px-3 text-right">{idr(r.amount)}</td>
              </tr>
            ))}
            {list && list.items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-brand-700/50">
                  Nothing here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {list && pages > 1 && (
        <div className="mt-3 flex items-center gap-3 text-sm">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-brand-600/20 px-3 py-1 disabled:opacity-40">
            Previous
          </button>
          <span>
            Page {page} of {pages} · {list.total} records
          </span>
          <button disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded border border-brand-600/20 px-3 py-1 disabled:opacity-40">
            Next
          </button>
        </div>
      )}

      {openId && <Detail id={openId} onClose={() => setOpenId(null)} />}
    </ConsoleShell>
  );
}

export default function LegacyPage() {
  return (
    <Suspense fallback={null}>
      <LegacyArchive />
    </Suspense>
  );
}
