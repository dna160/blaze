"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PipelineBookingDto, PipelineStageValue } from "@rentos/contracts";

import { ChangeRequestActions } from "@/components/ChangeRequests";
import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { canDo } from "@/lib/capabilities";
import { useT } from "@/lib/i18n";
import { notifyPendingApprovalsChanged } from "@/lib/pending-approvals";

// Titles and hints live in messages under workbench.col.<stage>.
const COLUMNS: Array<{ stage: PipelineStageValue }> = [
  { stage: "WAITLIST" },
  { stage: "APPROVAL" },
  { stage: "KYC" },
  { stage: "CONTRACT" },
  { stage: "FINANCE" },
];

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}

function fmtDate(value: string, intl: string): string {
  return new Date(value).toLocaleDateString(intl, { day: "numeric", month: "short", year: "numeric" });
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
  const { t, s, intl } = useT();
  const router = useRouter();
  const user = authClient.getUser();
  // Each matches the capability the API checks on that action.
  const canApprove = canDo(user, "approve_booking"); // approve, reject, request KYC
  const canOfferUnit = canDo(user, "fire_waitlist");
  const canGenerateContract = canDo(user, "create_booking");
  const canRequestChange = canDo(user, "request_booking_change");
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
      // The board just moved; re-count the sidebar badge rather than waiting out its poll.
      notifyPendingApprovalsChanged();
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
      setError(err instanceof ApiError ? err.message : t("workbench.actionFailed"));
    } finally {
      setBusyId(null);
    }
  }

  function reject(id: string) {
    const reason = window.prompt(t("workbench.rejectPrompt"));
    if (!reason) return;
    act(id, "reject", { reason }, t("workbench.rejected"));
  }

  const byStage = useMemo(() => {
    const map = new Map<PipelineStageValue, PipelineBookingDto[]>();
    for (const c of COLUMNS) map.set(c.stage, []);
    for (const b of bookings ?? []) map.get(b.pipelineStage)?.push(b);
    return map;
  }, [bookings]);

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">{t("workbench.title")}</h1>
      <p className="mt-1 text-sm text-brand-700/60">{t("workbench.intro")}</p>
      {error && <p className="mt-4 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {notice && <p className="mt-4 rounded bg-green-50 p-2 text-sm text-green-700">{notice}</p>}

      {!bookings ? (
        <p className="mt-6">{t("common.loading")}</p>
      ) : (
        <div className="mt-6 grid gap-4 lg:grid-cols-5">
          {COLUMNS.map((col) => {
            const items = byStage.get(col.stage) ?? [];
            return (
              <section key={col.stage} className="rounded-lg border border-brand-600/10 bg-brand-700/[0.03] p-3">
                <header className="mb-3">
                  <h2 className="flex items-center justify-between text-sm font-semibold">
                    {t(`workbench.col.${col.stage}.title`)}
                    <span className="rounded-full bg-brand-700/10 px-2 py-0.5 text-xs">{items.length}</span>
                  </h2>
                  <p className="text-xs text-brand-700/50">{t(`workbench.col.${col.stage}.hint`)}</p>
                </header>
                <div className="space-y-3">
                  {items.length === 0 && <p className="text-xs text-brand-700/40">{t("workbench.empty")}</p>}
                  {items.map((b) => (
                    <article key={b.id} className="rounded-lg border border-brand-600/10 bg-white p-3 text-sm shadow-sm">
                      <Link href={`/bookings/${b.id}`} className="font-medium hover:underline">
                        {b.customer.fullName ?? b.customer.phone ?? b.customer.email ?? t("workbench.customer")}
                      </Link>
                      <p className="text-xs text-brand-700/60">
                        {b.customer.preferredChannel === "EMAIL" ? b.customer.email : b.customer.phone}
                        {b.customer.preferredChannel === "EMAIL" ? ` · ${t("workbench.viaEmail")}` : " · WhatsApp"}
                      </p>
                      <p className="mt-2 text-xs">
                        {b.assetType.name}
                        {b.asset ? ` — ${b.asset.code}` : b.pipelineStage === "WAITLIST" ? t("workbench.noUnit") : ""}
                        {b.location ? ` · ${b.location.name}` : ""}
                      </p>
                      <p className="text-xs text-brand-700/60">
                        {fmtDate(b.startDate, intl)}
                        {b.termMonths ? t("workbench.months", { count: b.termMonths }) : b.endDate ? ` → ${fmtDate(b.endDate, intl)}` : ""}
                        {b.waitlistPosition ? t("workbench.inLine", { n: b.waitlistPosition }) : ""}
                      </p>
                      <p className="mt-1 text-xs italic text-brand-700/60">{b.stageDetail}</p>
                      {b.pipelineStage === "KYC" && (
                        <p className="mt-1 text-xs">
                          KYC: <span className="font-medium">{s(b.customer.kycStatus)}</span>
                          {b.customer.kycStatus === "PENDING_REVIEW" && (
                            <>
                              {" "}
                              · <Link href="/kyc" className="underline">{t("workbench.review")}</Link>
                            </>
                          )}
                        </p>
                      )}
                      {b.firstInvoice && (
                        <p className="mt-1 text-xs">
                          <Link href={`/invoices/${b.firstInvoice.id}`} className="underline">
                            {b.firstInvoice.invoiceNumber}
                          </Link>{" "}
                          · {formatIDR(b.firstInvoice.totalAmount)} · {s(b.firstInvoice.status)}
                        </p>
                      )}

                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {col.stage === "WAITLIST" && (
                          <>
                            {canOfferUnit && (
                              <button onClick={() => act(b.id, "offer-unit", {}, t("workbench.offered"))} disabled={busyId === b.id} className="rounded bg-brand-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                                {t("workbench.offerUnit")}
                              </button>
                            )}
                            {canApprove && (
                              <button onClick={() => reject(b.id)} disabled={busyId === b.id} className="rounded border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-50">
                                {t("workbench.close")}
                              </button>
                            )}
                          </>
                        )}
                        {col.stage === "APPROVAL" && canApprove && (
                          <>
                            <button onClick={() => act(b.id, "approve", {}, t("workbench.approved"))} disabled={busyId === b.id} className="rounded bg-brand-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                              {t("workbench.approve")}
                            </button>
                            <button onClick={() => reject(b.id)} disabled={busyId === b.id} className="rounded border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-50">
                              {t("workbench.reject")}
                            </button>
                          </>
                        )}
                        {col.stage === "KYC" && canApprove && (
                          <button onClick={() => act(b.id, "request-kyc", {}, t("workbench.kycSent"))} disabled={busyId === b.id} className="rounded bg-brand-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                            {b.kycRequestedAt ? t("workbench.resendKyc") : t("workbench.requestKyc")}
                          </button>
                        )}
                        {col.stage === "CONTRACT" && canGenerateContract && (
                          <button onClick={() => act(b.id, "generate-contract", {}, t("workbench.contractSent"))} disabled={busyId === b.id} className="rounded bg-brand-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                            {t("workbench.generateContract")}
                          </button>
                        )}
                        {col.stage === "FINANCE" && b.firstInvoice && (
                          <Link href={`/invoices/${b.firstInvoice.id}`} className="rounded bg-brand-700 px-3 py-1.5 text-xs font-medium text-white">
                            {t("workbench.openInvoice")}
                          </Link>
                        )}
                      </div>
                      {/* PRD go-live 2 §4 — after approval a booking is cancelled or re-dated by request + approval, never directly. */}
                      {(col.stage === "KYC" || col.stage === "CONTRACT" || col.stage === "FINANCE") && canRequestChange && (
                        <div className="mt-2 border-t border-brand-600/10 pt-2">
                          <ChangeRequestActions bookingId={b.id} compact onChanged={() => load()} />
                        </div>
                      )}
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
