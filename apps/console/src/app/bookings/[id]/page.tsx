"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { BookingDto, ContractDto, InvoiceDto, PipelineBookingDto } from "@rentos/contracts";

import { ChangeRequestActions, ChangeRequestPanel } from "@/components/ChangeRequests";
import { ArrearsBadgeFor } from "@/components/ArrearsBadge";
import { ConsoleShell } from "@/components/ConsoleShell";
import { OvertimeCharge } from "@/components/OvertimeCharge";
import { KycPanel } from "@/components/KycPanel";
import { SignedScanUpload } from "@/components/SignedScanUpload";
import { apiFetch, apiFetchBlob, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { canDo } from "@/lib/capabilities";
import { hasMessage, useT } from "@/lib/i18n";

/** The contract row as the API returns it — ContractDto plus the go-live fields (PRD go-live §6.2, §7.2). */
type ContractRow = ContractDto & {
  contractNumber?: string | null;
  confirmedAt?: string | null;
  documentUrl?: string | null;
  signatureImageKey?: string | null;
  companyStampPresent?: boolean | null;
};

interface BookingWithRelations extends BookingDto {
  customer: { id: string; fullName: string | null; phone: string | null; email: string | null; kycStatus: string; preferredChannel: string; type?: "INDIVIDUAL" | "BUSINESS" };
  assetType: { name: string };
  asset: { code: string } | null;
  location: { name: string } | null;
  events: Array<{ id: string; fromStatus: string | null; toStatus: string; actorType: string; reason: string | null; createdAt: string }>;
}

function formatIDR(amount: string | number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}

/** Staff-side booking detail — contract status + upload-on-customer's-behalf for a paper contract collected in person (PRD §5.3). */
export default function BookingDetailPage() {
  const { t, s, intl } = useT();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [booking, setBooking] = useState<BookingWithRelations | null>(null);
  const [contract, setContract] = useState<ContractRow | null>(null);
  const [confirming, setConfirming] = useState(false);
  const canConfirm = canDo(authClient.getUser(), "approve_booking");
  const [pipeline, setPipeline] = useState<PipelineBookingDto | null>(null);
  const [invoices, setInvoices] = useState<InvoiceDto[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stayActionBusy, setStayActionBusy] = useState(false);
  // PRD go-live 2 §5.3 — how the contract will be signed, chosen at the contract step.
  const [signMethod, setSignMethod] = useState<"ONLINE" | "OFFLINE">("ONLINE");

  const [changeReload, setChangeReload] = useState(0);

  const fmtDate = (value: string | null | undefined) =>
    value ? new Date(value).toLocaleDateString(intl, { day: "numeric", month: "short", year: "numeric" }) : "—";

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const b = await apiFetch<BookingWithRelations>(`/bookings/${id}`, { token });
      setBooking(b);
      if (!["DRAFT", "WAITLISTED", "PENDING_APPROVAL", "NEEDS_INFO"].includes(b.status)) {
        // No contract yet comes back as an empty body; that is "none", not a failure to load the booking.
        const c = await apiFetch<ContractRow | null>(`/contracts/by-booking/${id}`, { token }).catch(() => null);
        setContract(c);
      }
      // Pipeline stage + the booking's invoices (schedule) — both tolerate failure so the page still renders.
      apiFetch<PipelineBookingDto[]>("/bookings/pipeline", { token })
        .then((rows) => setPipeline(rows.find((r) => r.id === id) ?? null))
        .catch(() => setPipeline(null));
      apiFetch<InvoiceDto[]>("/invoices", { token })
        .then((all) => setInvoices(all.filter((i) => i.bookingId === id).sort((a, c) => (a.scheduleIndex ?? 99) - (c.scheduleIndex ?? 99))))
        .catch(() => setInvoices([]));
    } catch {
      router.push("/bookings");
    }
  }

  async function pipelineAction(path: string, success: string, body: Record<string, unknown> = {}) {
    const token = authClient.getToken();
    if (!token) return;
    setStayActionBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/bookings/${id}/${path}`, { token, method: "POST", body });
      setNotice(success);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("booking.actionFailed"));
    } finally {
      setStayActionBusy(false);
    }
  }

  async function openContractPdf() {
    const token = authClient.getToken();
    if (!token || !contract) return;
    try {
      const blob = await apiFetchBlob(`/contracts/${contract.id}/document`, token);
      window.open(URL.createObjectURL(blob), "_blank", "noopener");
    } catch {
      setError(t("booking.openPdfFailed"));
    }
  }

  /** Signed copy: the signature-pad PDF (with the stamp once confirmed) or the uploaded scan. */
  async function openSignedContract() {
    const token = authClient.getToken();
    if (!token || !contract) return;
    try {
      const blob = await apiFetchBlob(`/contracts/${contract.id}/file`, token);
      window.open(URL.createObjectURL(blob), "_blank", "noopener");
    } catch {
      setError(t("booking.openSignedFailed"));
    }
  }

  /** PRD go-live §7.2 — staff approve the signed contract; the PDF gets the CONFIRMED stamp. */
  async function confirmContract() {
    const token = authClient.getToken();
    if (!token || !contract) return;
    setConfirming(true);
    setError(null);
    try {
      await apiFetch(`/contracts/${contract.id}/confirm`, { token, method: "POST", body: {} });
      setNotice(t("booking.confirmed"));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("booking.confirmFailed"));
    } finally {
      setConfirming(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /** PRD go-live 2 §5.3 — switch an unsigned contract between online and paper signing. */
  async function changeSignMethod(next: "ONLINE" | "OFFLINE") {
    const token = authClient.getToken();
    if (!token || !contract) return;
    setStayActionBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/contracts/${contract.id}/sign-method`, { token, method: "POST", body: { signMethod: next } });
      setNotice(next === "OFFLINE" ? t("booking.toOffline") : t("booking.toOnline"));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("booking.signMethodFailed"));
    } finally {
      setStayActionBusy(false);
    }
  }

  async function performStayAction(action: "check-in" | "check-out" | "pickup" | "return" | "complete-inspection") {
    const token = authClient.getToken();
    if (!token) return;
    setStayActionBusy(true);
    setError(null);
    try {
      await apiFetch(`/bookings/${id}/${action}`, { token, method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("booking.stayFailed", { action }));
    } finally {
      setStayActionBusy(false);
    }
  }

  if (!booking) {
    return (
      <ConsoleShell>
        <p>{t("common.loading")}</p>
      </ConsoleShell>
    );
  }

  const esignPending = contract?.esignStatus === "PENDING";
  const canUploadContract = booking.status === "APPROVED" && contract && !contract.signedAt && !esignPending;

  const isTermLease = booking.bookingModel === "RECURRING_LEASE" && Boolean(booking.termMonths);
  const stage = pipeline?.pipelineStage;
  const stageLabel = (st: string) => (hasMessage(`booking.stage.${st}`) ? t(`booking.stage.${st}`) : st.replace("_", " "));
  const actorLabel = (a: string) => (hasMessage(`booking.actor.${a}`) ? t(`booking.actor.${a}`) : a.toLowerCase());

  return (
    <ConsoleShell>
      <Link href="/bookings" className="text-sm text-brand-700/60 hover:underline">
        {t("booking.back")}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold">
        <Link href={`/clients/${booking.customer.id}`} className="hover:underline">
          {booking.customer.fullName ?? booking.customer.phone ?? booking.customer.email}
        </Link>{" "}
        <ArrearsBadgeFor customerId={booking.customer.id} />
      </h1>
      <p className="mt-1 text-sm text-brand-700/60">
        {booking.assetType.name} — {booking.asset ? t("booking.unit", { code: booking.asset.code }) : t("booking.noUnit")}
        {booking.location ? ` · ${booking.location.name}` : ""} · {fmtDate(booking.startDate)}
        {booking.endDate ? ` → ${fmtDate(booking.endDate)}` : ""}
        {booking.termMonths ? <> · {t("booking.termMonths", { months: booking.termMonths })}</> : null} · {t("booking.statusLine", { status: s(booking.status) })}
        {contract?.contractNumber ? (
          <>
            {" · "}
            <span className="font-medium text-brand-700">{t("booking.contractNo", { number: contract.contractNumber })}</span>
          </>
        ) : null}
      </p>
      <p className="text-xs text-brand-700/50">
        {booking.customer.phone ?? t("booking.noPhone")} · {booking.customer.email ?? t("booking.noEmail")} ·{" "}
        {booking.customer.preferredChannel === "EMAIL" ? t("booking.viaEmail") : t("booking.viaWhatsapp")} · {t("booking.kyc", { status: s(booking.customer.kycStatus) })}
      </p>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {notice && <p className="mt-2 text-sm text-green-700">{notice}</p>}

      {isTermLease && pipeline && stage && stage !== "ACTIVE" && stage !== "CLOSED" && (
        <div className="mt-6 rounded-lg border border-brand-600/10 bg-white p-5">
          <h2 className="font-medium">{t("booking.pipeline", { stage: stageLabel(stage) })}</h2>
          <p className="mt-1 text-sm text-brand-700/60">{pipeline.stageDetail}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {stage === "WAITLIST" && (
              <button onClick={() => pipelineAction("offer-unit", t("booking.unitOffered"))} disabled={stayActionBusy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {t("booking.offerUnit")}
              </button>
            )}
            {stage === "APPROVAL" && (
              <button onClick={() => pipelineAction("approve", t("booking.approvedMsg"))} disabled={stayActionBusy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {t("booking.approve")}
              </button>
            )}
            {stage === "KYC" && (
              <button onClick={() => pipelineAction("request-kyc", t("booking.kycSent"))} disabled={stayActionBusy} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {booking.kycRequestedAt ? t("booking.resendKyc") : t("booking.requestKyc")}
              </button>
            )}
            {stage === "CONTRACT" && (
              <div className="flex flex-wrap items-center gap-3" data-testid="sign-method-choice">
                <fieldset className="flex items-center gap-3 text-sm">
                  <legend className="sr-only">{t("booking.signHow")}</legend>
                  <span className="text-brand-700/60">{t("booking.signLabel")}</span>
                  <label className="flex items-center gap-1">
                    <input type="radio" name="signMethod" checked={signMethod === "ONLINE"} onChange={() => setSignMethod("ONLINE")} /> {t("booking.signOnline")}
                  </label>
                  <label className="flex items-center gap-1">
                    <input type="radio" name="signMethod" checked={signMethod === "OFFLINE"} onChange={() => setSignMethod("OFFLINE")} /> {t("booking.signOffline")}
                  </label>
                </fieldset>
                <button
                  onClick={() => pipelineAction("generate-contract", signMethod === "OFFLINE" ? t("booking.generatedOffline") : t("booking.generatedOnline"), { signMethod })}
                  disabled={stayActionBusy}
                  className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {t("booking.generate")}
                </button>
              </div>
            )}
            {stage === "FINANCE" && pipeline.firstInvoice && (
              <Link href={`/invoices/${pipeline.firstInvoice.id}`} className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white">
                {t("booking.openProforma", { number: pipeline.firstInvoice.invoiceNumber })}
              </Link>
            )}
          </div>
        </div>
      )}

      {invoices.length > 0 && (
        <div className="mt-6 rounded-lg border border-brand-600/10 bg-white p-5">
          <h2 className="font-medium">{isTermLease ? t("booking.schedule") : t("booking.invoices")}</h2>
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs text-brand-700/60">
              <tr>
                <th className="py-1">#</th>
                <th className="py-1">{t("common.invoice")}</th>
                <th className="py-1">{t("common.period")}</th>
                <th className="py-1">{t("common.dueDate")}</th>
                <th className="py-1">{t("common.status")}</th>
                <th className="py-1 text-right">{t("common.amount")}</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-t border-brand-600/10">
                  <td className="py-1">{inv.scheduleIndex !== null && inv.scheduleIndex !== undefined ? inv.scheduleIndex + 1 : "—"}</td>
                  <td className="py-1">
                    <Link href={`/invoices/${inv.id}`} className="hover:underline">
                      {inv.invoiceNumber.startsWith("SCHEDULED/") ? (
                        <span className="text-brand-700/50">{t("booking.numberedWhenIssued")}</span>
                      ) : (
                        t("booking.invoiceNo", { number: inv.invoiceNumber })
                      )}
                    </Link>
                  </td>
                  <td className="py-1 text-xs text-brand-700/60">
                    {inv.periodStart && inv.periodEnd ? `${fmtDate(inv.periodStart)} – ${fmtDate(inv.periodEnd)}` : "—"}
                  </td>
                  <td className="py-1">{fmtDate(inv.dueDate)}</td>
                  <td className="py-1">{s(inv.status)}</td>
                  <td className="py-1 text-right">{formatIDR(inv.totalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 rounded-lg border border-brand-600/10 bg-white p-5" data-testid="booking-change-requests">
        <h2 className="font-medium">{t("booking.changeRequests")}</h2>
        <p className="mt-1 text-xs text-brand-700/60">{t("booking.changeRequestsHint")}</p>
        {canDo(authClient.getUser(), "request_booking_change") && ["PENDING_APPROVAL", "NEEDS_INFO", "APPROVED"].includes(booking.status) && (
          <div className="mt-3">
            <ChangeRequestActions bookingId={booking.id} onChanged={() => { setChangeReload((n) => n + 1); load(); }} />
          </div>
        )}
        <div className="mt-3">
          <ChangeRequestPanel bookingId={booking.id} reloadKey={changeReload} />
        </div>
      </div>

      {booking.bookingModel === "NIGHTLY" && (booking.status === "PAID" || booking.status === "CHECKED_IN") && (
        <div className="mt-6 rounded-lg border border-brand-600/10 bg-white p-5">
          <h2 className="font-medium">{t("booking.stay")}</h2>
          {booking.status === "PAID" ? (
            <>
              <p className="mt-2 text-sm text-brand-700/60">{t("booking.paidReadyCheckIn")}</p>
              <button
                onClick={() => performStayAction("check-in")}
                disabled={stayActionBusy}
                className="mt-3 rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {stayActionBusy ? t("booking.checkingIn") : t("booking.checkIn")}
              </button>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm text-brand-700/60">{t("booking.checkedInNote")}</p>
              <button
                onClick={() => performStayAction("check-out")}
                disabled={stayActionBusy}
                className="mt-3 rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {stayActionBusy ? t("booking.checkingOut") : t("booking.checkOut")}
              </button>
            </>
          )}
        </div>
      )}

      {booking.bookingModel === "DURATION_ORDER" &&
        (booking.status === "PAID" ||
          booking.status === "PICKED_UP" ||
          booking.status === "RETURNED" ||
          booking.status === "INSPECTION") && (
          <div className="mt-6 rounded-lg border border-brand-600/10 bg-white p-5">
            <h2 className="font-medium">{t("booking.order")}</h2>
            {booking.status === "PAID" && (
              <>
                <p className="mt-2 text-sm text-brand-700/60">{t("booking.paidReadyPickup")}</p>
                <button
                  onClick={() => performStayAction("pickup")}
                  disabled={stayActionBusy}
                  className="mt-3 rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {stayActionBusy ? t("booking.recordingPickup") : t("booking.markPickedUp")}
                </button>
              </>
            )}
            {booking.status === "PICKED_UP" && (
              <>
                <p className="mt-2 text-sm text-brand-700/60">{t("booking.outWithCustomer")}</p>
                <button
                  onClick={() => performStayAction("return")}
                  disabled={stayActionBusy}
                  className="mt-3 rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {stayActionBusy ? t("booking.recordingReturn") : t("booking.markReturned")}
                </button>
              </>
            )}
            {booking.status === "INSPECTION" && (
              <>
                <p className="mt-2 text-sm text-brand-700/60">{t("booking.inspectionNote")}</p>
                <button
                  onClick={() => performStayAction("complete-inspection")}
                  disabled={stayActionBusy}
                  className="mt-3 rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {stayActionBusy ? t("booking.closing") : t("booking.completeInspection")}
                </button>
              </>
            )}
          </div>
        )}

      {contract && (
        <div className="mt-6 rounded-lg border border-brand-600/10 bg-white p-5">
          <h2 className="font-medium">
            {t("booking.agreement")}
            {contract.contractNumber ? <> — {t("booking.contractNo", { number: contract.contractNumber })}</> : null}
            {contract.confirmedAt && (
              <span className="ml-2 rounded border-2 border-green-700 px-2 py-0.5 text-xs font-bold tracking-wide text-green-700">CONFIRMED</span>
            )}
          </h2>
          {contract.unsignedDocumentUrl && (
            <button onClick={openContractPdf} className="mt-1 text-sm text-accent-500 underline">
              {t("booking.openGenerated")}
            </button>
          )}
          {contract.signedAt ? (
            <div className="mt-2 space-y-2 text-sm">
              <p className="text-green-700">
                {t("booking.signedBy", { name: contract.signedByName, date: new Date(contract.signedAt).toLocaleDateString(intl) })}
                {contract.esignProvider === "SIGNATURE_PAD" ? t("booking.viaPad") : contract.esignProvider === "LEGACY" ? t("booking.viaLegacy") : ""}.
                {contract.confirmedAt ? <> {t("booking.confirmedOn", { date: new Date(contract.confirmedAt).toLocaleDateString(intl) })}</> : null}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {contract.documentUrl && (
                  <button onClick={openSignedContract} className="text-accent-500 underline">
                    {t("booking.openSigned")}
                  </button>
                )}
                {!contract.confirmedAt && canConfirm && (
                  <button
                    onClick={confirmContract}
                    disabled={confirming}
                    className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {confirming ? t("booking.confirming") : t("booking.confirmContract")}
                  </button>
                )}
              </div>
            </div>
          ) : esignPending ? (
            <p className="mt-2 text-sm text-amber-700">{t("booking.esignPending", { provider: contract.esignProvider })}</p>
          ) : (
            <div className="mt-2 space-y-1 text-sm" data-testid="sign-method-status">
              {contract.signMethod === "OFFLINE" ? (
                <p className="text-amber-800">{t("booking.offlineDeadline", { date: contract.signDeadlineAt ? fmtDate(contract.signDeadlineAt) : "—" })}</p>
              ) : (
                <p className="text-brand-700/60">
                  {t("booking.onlineWaiting", { how: contract.esignAvailable ? t("booking.esignService") : t("booking.signaturePad") })}
                </p>
              )}
              {booking.status === "APPROVED" && (
                <button
                  type="button"
                  onClick={() => void changeSignMethod(contract.signMethod === "OFFLINE" ? "ONLINE" : "OFFLINE")}
                  disabled={stayActionBusy}
                  className="text-xs text-accent-500 underline disabled:opacity-50"
                >
                  {contract.signMethod === "OFFLINE" ? t("booking.switchToOnline") : t("booking.switchToOffline")}
                </button>
              )}
            </div>
          )}

          {canUploadContract && (
            <div className="mt-4 border-t border-brand-600/10 pt-4">
              <SignedScanUpload bookingId={id} isCompany={booking.customer.type === "BUSINESS"} onDone={() => { setNotice(t("booking.scanSaved")); void load(); }} />
            </div>
          )}
        </div>
      )}

      {["ACTIVE", "RENEWING", "SUSPENDED", "NOTICE_GIVEN"].includes(booking.status) && canDo(authClient.getUser(), "create_booking") && (
        <OvertimeCharge bookingId={booking.id} onCharged={() => void load()} />
      )}

      {booking.status === "APPROVED" && !["VERIFIED", "VERIFIED_LEGACY"].includes(booking.customer.kycStatus) && (
        <div className="mt-6">
          <KycPanel customerId={booking.customer.id} bookingId={booking.id} onChanged={() => void load()} />
        </div>
      )}

      {booking.events.length > 0 && (
        <div className="mt-6 rounded-lg border border-brand-600/10 bg-white p-5">
          <h2 className="font-medium">{t("booking.timeline")}</h2>
          <ul className="mt-2 space-y-1 text-xs">
            {booking.events.map((e) => (
              <li key={e.id} className="flex justify-between gap-3 border-t border-brand-600/10 py-1">
                <span>
                  {e.fromStatus ? `${s(e.fromStatus)} → ` : ""}
                  <span className="font-medium">{s(e.toStatus)}</span>
                  {e.reason ? ` — ${e.reason}` : ""}
                </span>
                <span className="shrink-0 text-brand-700/50">
                  {actorLabel(e.actorType)} · {new Date(e.createdAt).toLocaleString(intl, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ConsoleShell>
  );
}
