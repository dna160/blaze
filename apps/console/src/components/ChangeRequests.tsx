"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { AvailableUnitsForDateDto, ChangeRequestDto, ChangeRequestOptionsDto } from "@rentos/contracts";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { CHANGE_STATUS_STYLE, changeStatusLabel, changeTypeLabel, fmtDateTime, fmtDay, notifyChangeRequestsChanged } from "@/lib/change-requests";
import { tr, useT } from "@/lib/i18n";

/**
 * PRD go-live 2 §4 — the request forms and the request cards, shared by the
 * booking page, the workbench card, the client page and the Requests page.
 */

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return tr("common.errorGeneric");
}

// ----------------------------------------------------------------- the form

export function ChangeRequestForm({
  bookingId,
  kind,
  onDone,
  onCancel,
}: {
  bookingId: string;
  kind: "CANCEL" | "CHANGE_START_DATE";
  onDone: (created: ChangeRequestDto) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [options, setOptions] = useState<ChangeRequestOptionsDto | null>(null);
  const [reason, setReason] = useState("");
  const [newStartDate, setNewStartDate] = useState("");
  const [assetId, setAssetId] = useState<string>("");
  const [signedContract, setSignedContract] = useState<"RESIGN" | "RECONFIRM" | "">("");
  const [units, setUnits] = useState<AvailableUnitsForDateDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<ChangeRequestOptionsDto>(`/change-requests/options/${bookingId}`, { token: authClient.getToken() })
      .then(setOptions)
      .catch((e) => setError(errorText(e)));
  }, [bookingId]);

  // A new date: which units of this type are free for it (the booked one first).
  useEffect(() => {
    setUnits(null);
    if (kind !== "CHANGE_START_DATE" || !/^\d{4}-\d{2}-\d{2}$/.test(newStartDate)) return;
    apiFetch<AvailableUnitsForDateDto>(`/change-requests/available-units/${bookingId}?newStartDate=${newStartDate}`, { token: authClient.getToken() })
      .then((u) => {
        setUnits(u);
        setAssetId(u.currentUnitFree ? "" : (u.units[0]?.id ?? ""));
      })
      .catch((e) => setError(errorText(e)));
  }, [bookingId, kind, newStartDate]);

  const blocked = options ? (kind === "CANCEL" ? options.cancelBlockedReason : options.changeStartDateBlockedReason) : null;
  const needsSignedChoice = kind === "CHANGE_START_DATE" && Boolean(options?.contractSigned);
  const noUnitFree = kind === "CHANGE_START_DATE" && units !== null && !units.currentUnitFree && units.units.length === 0;
  const ready =
    options !== null &&
    !blocked &&
    reason.trim().length >= 5 &&
    (kind === "CANCEL" || (newStartDate && units !== null && !noUnitFree && (!needsSignedChoice || signedContract)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const body =
        kind === "CANCEL"
          ? { type: "CANCEL", bookingId, reason: reason.trim() }
          : {
              type: "CHANGE_START_DATE",
              bookingId,
              reason: reason.trim(),
              newStartDate,
              ...(assetId ? { assetId } : {}),
              ...(signedContract ? { signedContract } : {}),
            };
      const created = await apiFetch<ChangeRequestDto>("/change-requests", { token: authClient.getToken(), method: "POST", body });
      notifyChangeRequestsChanged();
      onDone(created);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const title = kind === "CANCEL" ? t("requests.form.titleCancel") : t("requests.form.titleDate");

  return (
    <form onSubmit={submit} className="space-y-3 rounded border border-brand-600/15 bg-white p-4 text-sm" data-testid={`change-request-form-${kind}`}>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{title}</h3>
        <button type="button" onClick={onCancel} className="text-xs text-brand-700/60 hover:text-brand-700">
          {t("common.close")}
        </button>
      </div>
      {!options && !error && <p className="text-brand-700/60">{t("common.loading")}</p>}
      {blocked && <p className="rounded bg-amber-50 px-3 py-2 text-amber-800">{blocked}</p>}
      {options && !blocked && (
        <>
          {kind === "CANCEL" ? (
            <p className="text-brand-700/70">
              {options.cancelIsImmediate ? t("requests.form.cancelImmediate") : t("requests.form.cancelNeedsApproval")}
            </p>
          ) : (
            <>
              <p className="text-brand-700/70">
                {t("requests.form.currentStart", { date: fmtDay(options.startDate) })}
                {options.assetCode ? <> · {t("requests.form.unitCode", { code: options.assetCode })}</> : null}
                {options.termMonths ? <> · {t("requests.form.months", { months: options.termMonths })}</> : null}. {t("requests.form.approvedBy")}
              </p>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-brand-700/60">{t("requests.form.newStart")}</span>
                <input type="date" value={newStartDate} onChange={(e) => setNewStartDate(e.target.value)} className="w-48 rounded border border-brand-600/20 px-2 py-1.5" required />
              </label>
              {units && (
                <div className="space-y-1">
                  {units.currentUnitFree ? (
                    <p className="text-green-700">{t("requests.form.unitFree", { code: options.assetCode })}</p>
                  ) : noUnitFree ? (
                    <p className="rounded bg-red-50 px-3 py-2 text-red-700">{t("requests.form.noUnitFree")}</p>
                  ) : (
                    <p className="text-amber-800">{t("requests.form.unitTaken", { code: options.assetCode ?? t("requests.form.currentUnit") })}</p>
                  )}
                  {units.units.length > 0 && (
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-brand-700/60">{t("common.unit")}</span>
                      <select value={assetId} onChange={(e) => setAssetId(e.target.value)} className="w-48 rounded border border-brand-600/20 px-2 py-1.5">
                        {units.currentUnitFree && <option value="">{t("requests.form.keep", { code: options.assetCode })}</option>}
                        {units.units
                          .filter((u) => !u.current)
                          .map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.code}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                </div>
              )}
              {needsSignedChoice && (
                <fieldset className="space-y-1">
                  <legend className="text-xs text-brand-700/60">{t("requests.form.signedQuestion")}</legend>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="signed" checked={signedContract === "RESIGN"} onChange={() => setSignedContract("RESIGN")} />
                    <span>{t("requests.form.resign")}</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="signed" checked={signedContract === "RECONFIRM"} onChange={() => setSignedContract("RECONFIRM")} />
                    <span>{t("requests.form.reconfirm")}</span>
                  </label>
                </fieldset>
              )}
            </>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-brand-700/60">{t("requests.form.reason")}</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="rounded border border-brand-600/20 px-2 py-1.5" placeholder={t("requests.form.reasonPlaceholder")} required />
          </label>
          <button type="submit" disabled={!ready || busy} className={`rounded px-3 py-1.5 font-medium text-white disabled:opacity-40 ${kind === "CANCEL" ? "bg-red-600" : "bg-brand-700"}`}>
            {busy ? t("common.sending") : kind === "CANCEL" && options.cancelIsImmediate ? t("requests.form.cancelNow") : t("requests.form.send")}
          </button>
        </>
      )}
      {error && <p className="text-red-600">{error}</p>}
    </form>
  );
}

// ----------------------------------------------------- buttons opening it

/** "Ajukan pembatalan" / "Ajukan ubah tanggal" for one booking, with the form inline. */
export function ChangeRequestActions({ bookingId, compact = false, onChanged }: { bookingId: string; compact?: boolean; onChanged?: (created: ChangeRequestDto) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState<"CANCEL" | "CHANGE_START_DATE" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const btn = compact ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setOpen(open === "CHANGE_START_DATE" ? null : "CHANGE_START_DATE")} className={`rounded border border-brand-600/20 font-medium hover:bg-brand-700/5 ${btn}`}>
          {t("requests.actions.date")}
        </button>
        <button type="button" onClick={() => setOpen(open === "CANCEL" ? null : "CANCEL")} className={`rounded border border-red-300 font-medium text-red-600 hover:bg-red-50 ${btn}`}>
          {t("requests.actions.cancel")}
        </button>
      </div>
      {open && (
        <ChangeRequestForm
          bookingId={bookingId}
          kind={open}
          onCancel={() => setOpen(null)}
          onDone={(created) => {
            setOpen(null);
            setNotice(
              created.status === "APPROVED"
                ? t("requests.actions.cancelled")
                : created.type === "CANCEL"
                  ? t("requests.actions.cancelSent")
                  : t("requests.actions.dateSent"),
            );
            onChanged?.(created);
          }}
        />
      )}
      {notice && <p className="text-xs text-green-700">{notice}</p>}
    </div>
  );
}

// ------------------------------------------------------------ a request card

export function ChangeRequestCard({ request, onChanged, showBooking = true }: { request: ChangeRequestDto; onChanged: () => void; showBooking?: boolean }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const r = request;
  const p = r.payload;

  async function decide(decision: "APPROVE" | "REJECT") {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/change-requests/${r.id}/decide`, { token: authClient.getToken(), method: "POST", body: { decision, ...(note.trim() ? { note: note.trim() } : {}) } });
      notifyChangeRequestsChanged();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!window.confirm(t("requests.card.withdrawConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/change-requests/${r.id}/withdraw`, { token: authClient.getToken(), method: "POST" });
      notifyChangeRequestsChanged();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const result = r.result as { voidedInvoices?: Array<{ invoiceNumber: string }>; issuedInvoices?: Array<{ invoiceNumber: string }>; contract?: { version: number; signed: string } | null } | null;

  return (
    <article className="rounded border border-brand-600/10 bg-white p-4 text-sm" data-testid="change-request-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold">{changeTypeLabel(r.type)}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs ${CHANGE_STATUS_STYLE[r.status]}`}>{changeStatusLabel(r.status)}</span>
          </div>
          {showBooking && (
            <p className="mt-1 text-brand-700/70">
              <Link href={`/clients/${r.booking.customerId}`} className="font-medium text-brand-700 hover:underline">
                {r.booking.customerName}
              </Link>
              {r.booking.customerNumber ? ` · #${r.booking.customerNumber}` : ""} ·{" "}
              <Link href={`/bookings/${r.bookingId}`} className="hover:underline">
                {r.booking.assetTypeName} {r.booking.assetCode ?? ""}
              </Link>
              {r.booking.contractNumber ? <> · {t("requests.card.contract", { number: r.booking.contractNumber })}</> : null}
            </p>
          )}
        </div>
        <p className="text-xs text-brand-700/60">
          {t("requests.card.requestedBy", { name: r.requestedBy.name, when: fmtDateTime(r.requestedAt) })}
        </p>
      </div>

      {r.type === "CHANGE_START_DATE" && (
        <p className="mt-2">
          {t("requests.card.dateLine", { from: fmtDay(p.previousStartDate ?? r.booking.startDate), to: fmtDay(p.newStartDate) })}
          {p.assetCode ? <> · {t("requests.card.unitMove", { from: p.previousAssetCode ?? r.booking.assetCode, to: p.assetCode })}</> : null}
          {p.signedContract === "RESIGN" ? <> · {t("requests.card.resign")}</> : p.signedContract === "RECONFIRM" ? <> · {t("requests.card.reconfirm")}</> : null}
        </p>
      )}
      <p className="mt-1 text-brand-700/80">{t("requests.card.reason", { reason: r.reason })}</p>
      {r.status === "PENDING" && r.unitFree === false && (
        <p className="mt-2 rounded bg-red-50 px-3 py-2 text-red-700">{t("requests.card.unitNoLongerFree")}</p>
      )}

      {r.status !== "PENDING" && (
        <p className="mt-2 text-xs text-brand-700/60">
          {changeStatusLabel(r.status)}
          {r.decidedBy ? <> {t("requests.card.decidedBy", { name: r.decidedBy.name })}</> : null} · {fmtDateTime(r.decidedAt)}
          {r.decisionNote ? ` — ${r.decisionNote}` : ""}
        </p>
      )}
      {r.status === "APPROVED" && result && r.type === "CHANGE_START_DATE" && (
        <p className="mt-1 text-xs text-brand-700/60">
          {result.voidedInvoices?.length ? <>{t("requests.card.voided", { list: result.voidedInvoices.map((i) => i.invoiceNumber).join(", ") })} </> : null}
          {result.issuedInvoices?.length ? <>{t("requests.card.reissued", { list: result.issuedInvoices.map((i) => i.invoiceNumber).join(", ") })} </> : null}
          {result.contract
            ? t(
                result.contract.signed === "RESIGN_REQUIRED"
                  ? "requests.card.contractVersionResign"
                  : result.contract.signed === "RECONFIRM_REQUIRED"
                    ? "requests.card.contractVersionReconfirm"
                    : "requests.card.contractVersion",
                { version: result.contract.version },
              )
            : null}
        </p>
      )}

      {r.status === "PENDING" && (r.canDecide || r.canWithdraw || r.cannotDecideReason) && (
        <div className="mt-3 space-y-2">
          {r.cannotDecideReason === "SELF_DECISION" && <p className="text-xs text-brand-700/60">{t("requests.card.selfDecision")}</p>}
          {r.canDecide && rejecting && (
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="w-full rounded border border-brand-600/20 px-2 py-1.5" placeholder={t("requests.card.rejectReason")} />
          )}
          <div className="flex flex-wrap gap-1.5">
            {r.canDecide && !rejecting && (
              <>
                <button onClick={() => decide("APPROVE")} disabled={busy} className="rounded bg-brand-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                  {t("requests.card.approve")}
                </button>
                <button onClick={() => setRejecting(true)} disabled={busy} className="rounded border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-50">
                  {t("requests.card.reject")}
                </button>
              </>
            )}
            {r.canDecide && rejecting && (
              <>
                <button onClick={() => decide("REJECT")} disabled={busy || note.trim().length < 3} className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                  {t("requests.card.rejectRequest")}
                </button>
                <button onClick={() => setRejecting(false)} disabled={busy} className="rounded border border-brand-600/20 px-3 py-1.5 text-xs">
                  {t("common.cancel")}
                </button>
              </>
            )}
            {r.canWithdraw && (
              <button onClick={withdraw} disabled={busy} className="rounded border border-brand-600/20 px-3 py-1.5 text-xs disabled:opacity-50">
                {t("requests.card.withdraw")}
              </button>
            )}
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-red-600">{error}</p>}
    </article>
  );
}

// ------------------------------------------- requests of one booking / customer

/** The pending request(s) and the history, for the booking page and the client page. */
export function ChangeRequestPanel({ bookingId, customerId, reloadKey = 0 }: { bookingId?: string; customerId?: string; reloadKey?: number }) {
  const { t } = useT();
  const [rows, setRows] = useState<ChangeRequestDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    const q = bookingId ? `bookingId=${bookingId}` : `customerId=${customerId}`;
    apiFetch<ChangeRequestDto[]>(`/change-requests?status=ALL&${q}`, { token: authClient.getToken() })
      .then(setRows)
      .catch((e) => setError(errorText(e)));
  }, [bookingId, customerId]);
  useEffect(load, [load, reloadKey]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!rows) return <p className="text-sm text-brand-700/60">{t("requests.panel.loading")}</p>;
  if (rows.length === 0) return <p className="text-sm text-brand-700/60">{t("requests.panel.empty")}</p>;
  const pending = rows.filter((r) => r.status === "PENDING");
  const done = rows.filter((r) => r.status !== "PENDING");
  return (
    <div className="space-y-2" data-testid="change-request-panel">
      {pending.map((r) => (
        <ChangeRequestCard key={r.id} request={r} onChanged={load} showBooking={!bookingId} />
      ))}
      {done.length > 0 && (
        <details open={pending.length === 0}>
          <summary className="cursor-pointer text-xs text-brand-700/60">{t("requests.panel.history", { count: done.length })}</summary>
          <div className="mt-2 space-y-2">
            {done.map((r) => (
              <ChangeRequestCard key={r.id} request={r} onChanged={load} showBooking={!bookingId} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
