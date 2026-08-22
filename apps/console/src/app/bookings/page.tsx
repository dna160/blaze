"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PipelineBookingDto, PipelineStageValue } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

const COLUMNS: Array<{ stage: PipelineStageValue; title: string; hint: string }> = [
  { stage: "WAITLIST", title: "Waitlist", hint: "No unit free for their dates yet" },
  { stage: "APPROVAL", title: "Awaiting approval", hint: "Approve or reject" },
  { stage: "KYC", title: "Request KYC", hint: "Identity check before the contract" },
  { stage: "CONTRACT", title: "Contract + proforma", hint: "Generate the agreement and payment schedule" },
  { stage: "FINANCE", title: "Finance", hint: "Proforma awaiting payment" },
];

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * PRD v2 §5.1 — the approval pipeline: Waitlist -> Approval -> Request KYC
 * -> Contract + proforma -> Finance. One board, one primary action per
 * card; the stage is computed server-side (GET /bookings/pipeline), so this
 * page never has to re-derive it. NIGHTLY / DURATION_ORDER bookings flow
 * through the same columns (they skip KYC/contract and land in Finance
 * straight after approval, since their invoice is generated on approval).
 */
export default function BookingsPage() {
  const router = useRouter();
  const user = authClient.getUser();
  const canAct = user ? user.roles.some((r) => r === "SUPER_ADMIN" || r === "OPS_ADMIN") : false;
  const canFinance = user ? user.roles.some((r) => r === "SUPER_ADMIN" || r === "OPS_ADMIN" || r === "FINANCE_ADMIN") : false;
  const [bookings, setBookings] = useState<PipelineBookingDto[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const data = await apiFetch<PipelineBookingDto[]>("/bookings/pipeline", { token });
      setBookings(data);
    } catch (err) {
      if (err instanceof ApiError && err.status !== 401) setError(err.message);
      else {
        authClient.clear();
        router.push("/login");
      }
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(id: string, path: string, body: unknown, success: string) {
    const token = authClient.getToken();
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/bookings/${id}/${path}`, { token, method: "POST", body });
      setNotice(success);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed.");
    } finally {
      setBusyId(null);
    }
  }

  function reject(id: string) {
    const reason = window.prompt("Rejection reason (sent to the customer)?");
    if (!reason) return;
    act(id, "reject", { reason }, "Rejected — the customer has been told.");
  }

  const byStage = useMemo(() => {
    const map = new Map<PipelineStageValue, PipelineBookingDto[]>();
    for (const c of COLUMNS) map.set(c.stage, []);
    for (const b of bookings ?? []) map.get(b.pipelineStage)?.push(b);
    return map;
  }, [bookings]);

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">Approval Workbench</h1>
      <p className="mt-1 text-sm text-brand-700/60">
        Approval → Request KYC → Contract + proforma → Finance. Every customer message carries a sign-in link, so they never need an OTP to act.
      </p>
      {error && <p className="mt-4 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {notice && <p className="mt-4 rounded bg-green-50 p-2 text-sm text-green-700">{notice}</p>}

      {!bookings ? (
        <p className="mt-6">Loading...</p>
      ) : (
        <div className="mt-6 grid gap-4 lg:grid-cols-5">
          {COLUMNS.map((col) => {
            const items = byStage.get(col.stage) ?? [];
            return (
              <section key={col.stage} className="rounded-lg border border-brand-600/10 bg-brand-700/[0.03] p-3">
                <header className="mb-3">
                  <h2 className="flex items-center justify-between text-sm font-semibold">
                    {col.title}
                    <span className="rounded-full bg-brand-700/10 px-2 py-0.5 text-xs">{items.length}</span>
                  </h2>
                  <p className="text-xs text-brand-700/50">{col.hint}</p>
                </header>
                <div className="space-y-3">
                  {items.length === 0 && <p className="text-xs text-brand-700/40">Nothing here.</p>}
                  {items.map((b) => (
                    <article key={b.id} className="rounded-lg border border-brand-600/10 bg-white p-3 text-sm shadow-sm">
                      <Link href={`/bookings/${b.id}`} className="font-medium hover:underline">
                        {b.customer.fullName ?? b.customer.phone ?? b.customer.email ?? "Customer"}
                      </Link>
                      <p className="text-xs text-brand-700/60">
                        {b.customer.preferredChannel === "EMAIL" ? b.customer.email : b.customer.phone}
                        {b.customer.preferredChannel === "EMAIL" ? " · email" : " · WhatsApp"}
                      </p>
                      <p className="mt-2 text-xs">
                        {b.assetType.name}
                        {b.asset ? ` — ${b.asset.code}` : b.pipelineStage === "WAITLIST" ? " — no unit yet" : ""}
                        {b.location ? ` · ${b.location.name}` : ""}
                      </p>
                      <p className="text-xs text-brand-700/60">
                        {fmtDate(b.startDate)}
                        {b.termMonths ? ` · ${b.termMonths} mo` : b.endDate ? ` → ${fmtDate(b.endDate)}` : ""}
                        {b.waitlistPosition ? ` · #${b.waitlistPosition} in line` : ""}
                      </p>
                      <p className="mt-1 text-xs italic text-brand-700/60">{b.stageDetail}</p>
                      {b.pipelineStage === "KYC" && (
                        <p className="mt-1 text-xs">
                          KYC: <span className="font-medium">{b.customer.kycStatus}</span>
                          {b.customer.kycStatus === "PENDING_REVIEW" && (
                            <>
                              {" "}
                              · <Link href="/kyc" className="underline">review</Link>
                            </>
                          )}
                        </p>
                      )}
                      {b.firstInvoice && (
                        <p className="mt-1 text-xs">
                          <Link href={`/invoices/${b.firstInvoice.id}`} className="underline">
                            {b.firstInvoice.invoiceNumber}
                          </Link>{" "}
                          · {formatIDR(b.firstInvoice.totalAmount)} · {b.firstInvoice.status}
                        </p>
                      )}

                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {col.stage === "WAITLIST" && canAct && (
                          <>
                            <button onClick={() => act(b.id, "offer-unit", {}, "Unit offered — the customer has been told and the request is back in approval.")} disabled={busyId === b.id} className="rounded bg-brand-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                              Offer unit
                            </button>
                            <button onClick={() => reject(b.id)} disabled={busyId === b.id} className="rounded border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-50">
                              Close
                            </button>
                          </>
                        )}
                        {col.stage === "APPROVAL" && canAct && (
                          <>
                            <button onClick={() => act(b.id, "approve", {}, "Approved — the customer has been asked to verify their identity.")} disabled={busyId === b.id} className="rounded bg-brand-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                              Approve
                            </button>
                            <button onClick={() => reject(b.id)} disabled={busyId === b.id} className="rounded border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-50">
                              Reject
                            </button>
                          </>
                        )}
                        {col.stage === "KYC" && canAct && (
                          <button onClick={() => act(b.id, "request-kyc", {}, "KYC request sent with a sign-in link.")} disabled={busyId === b.id} className="rounded bg-brand-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                            {b.kycRequestedAt ? "Re-send KYC request" : "Request KYC"}
                          </button>
                        )}
                        {col.stage === "CONTRACT" && canFinance && (
                          <button onClick={() => act(b.id, "generate-contract", {}, "Contract + proforma generated and sent with a pay link.")} disabled={busyId === b.id} className="rounded bg-brand-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                            Generate contract + proforma
                          </button>
                        )}
                        {col.stage === "FINANCE" && b.firstInvoice && (
                          <Link href={`/invoices/${b.firstInvoice.id}`} className="rounded bg-brand-700 px-3 py-1.5 text-xs font-medium text-white">
                            Open invoice
                          </Link>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </ConsoleShell>
  );
}
