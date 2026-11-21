"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { AvailableUnitsForDateDto, ChangeRequestDto, ChangeRequestOptionsDto } from "@rentos/contracts";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { CHANGE_STATUS_LABEL, CHANGE_STATUS_STYLE, CHANGE_TYPE_LABEL, fmtDateTime, fmtDay, notifyChangeRequestsChanged } from "@/lib/change-requests";

/**
 * PRD go-live 2 §4 — the request forms and the request cards, shared by the
 * booking page, the workbench card, the client page and the Requests page.
 */

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Terjadi kesalahan. Coba lagi.";
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

  const title = kind === "CANCEL" ? "Ajukan pembatalan" : "Ajukan ubah tanggal mulai";

  return (
    <form onSubmit={submit} className="space-y-3 rounded border border-brand-600/15 bg-white p-4 text-sm" data-testid={`change-request-form-${kind}`}>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{title}</h3>
        <button type="button" onClick={onCancel} className="text-xs text-brand-700/60 hover:text-brand-700">
          Tutup
        </button>
      </div>
      {!options && !error && <p className="text-brand-700/60">Memuat…</p>}
      {blocked && <p className="rounded bg-amber-50 px-3 py-2 text-amber-800">{blocked}</p>}
      {options && !blocked && (
        <>
          {kind === "CANCEL" ? (
            <p className="text-brand-700/70">
              {options.cancelIsImmediate
                ? "Anda Super Admin: pembatalan langsung berlaku. Tagihan yang belum dibayar dibatalkan, unit dilepas, dan pelanggan diberi tahu."
                : "Permintaan ini dikirim ke Super Admin untuk disetujui. Setelah disetujui, tagihan yang belum dibayar dibatalkan, unit dilepas, dan pelanggan diberi tahu."}
            </p>
          ) : (
            <>
              <p className="text-brand-700/70">
                Tanggal mulai sekarang: <b>{fmtDay(options.startDate)}</b>
                {options.assetCode ? ` · unit ${options.assetCode}` : ""}
                {options.termMonths ? ` · ${options.termMonths} bulan` : ""}. Permintaan ini disetujui oleh supervisor atau admin.
              </p>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-brand-700/60">Tanggal mulai baru</span>
                <input type="date" value={newStartDate} onChange={(e) => setNewStartDate(e.target.value)} className="w-48 rounded border border-brand-600/20 px-2 py-1.5" required />
              </label>
              {units && (
                <div className="space-y-1">
                  {units.currentUnitFree ? (
                    <p className="text-green-700">Unit {options.assetCode} tersedia untuk tanggal ini.</p>
                  ) : noUnitFree ? (
                    <p className="rounded bg-red-50 px-3 py-2 text-red-700">Tidak ada unit tipe ini yang kosong untuk tanggal tersebut. Pilih tanggal lain.</p>
                  ) : (
                    <p className="text-amber-800">Unit {options.assetCode ?? "sekarang"} tidak tersedia untuk tanggal ini — pilih unit lain:</p>
                  )}
                  {units.units.length > 0 && (
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-brand-700/60">Unit</span>
                      <select value={assetId} onChange={(e) => setAssetId(e.target.value)} className="w-48 rounded border border-brand-600/20 px-2 py-1.5">
                        {units.currentUnitFree && <option value="">{options.assetCode} (tetap)</option>}
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
                  <legend className="text-xs text-brand-700/60">Kontrak sudah ditandatangani. Setelah tanggal diubah:</legend>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="signed" checked={signedContract === "RESIGN"} onChange={() => setSignedContract("RESIGN")} />
                    <span>Pelanggan menandatangani ulang kontrak versi baru</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="signed" checked={signedContract === "RECONFIRM"} onChange={() => setSignedContract("RECONFIRM")} />
                    <span>Tanda tangan tetap berlaku; staf mengonfirmasi ulang</span>
                  </label>
                </fieldset>
              )}
            </>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-brand-700/60">Alasan (wajib)</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="rounded border border-brand-600/20 px-2 py-1.5" placeholder="Mis. pelanggan minta mundur seminggu" required />
          </label>
          <button type="submit" disabled={!ready || busy} className={`rounded px-3 py-1.5 font-medium text-white disabled:opacity-40 ${kind === "CANCEL" ? "bg-red-600" : "bg-brand-700"}`}>
            {busy ? "Mengirim…" : kind === "CANCEL" && options.cancelIsImmediate ? "Batalkan booking" : "Kirim permintaan"}
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
  const [open, setOpen] = useState<"CANCEL" | "CHANGE_START_DATE" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const btn = compact ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setOpen(open === "CHANGE_START_DATE" ? null : "CHANGE_START_DATE")} className={`rounded border border-brand-600/20 font-medium hover:bg-brand-700/5 ${btn}`}>
          Ajukan ubah tanggal
        </button>
        <button type="button" onClick={() => setOpen(open === "CANCEL" ? null : "CANCEL")} className={`rounded border border-red-300 font-medium text-red-600 hover:bg-red-50 ${btn}`}>
          Ajukan pembatalan
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
                ? "Booking dibatalkan."
                : created.type === "CANCEL"
                  ? "Permintaan pembatalan terkirim — menunggu persetujuan Super Admin."
                  : "Permintaan ubah tanggal terkirim — menunggu persetujuan supervisor atau admin.",
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
    if (!window.confirm("Tarik permintaan ini?")) return;
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
            <span className="font-semibold">{CHANGE_TYPE_LABEL[r.type]}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs ${CHANGE_STATUS_STYLE[r.status]}`}>{CHANGE_STATUS_LABEL[r.status]}</span>
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
              {r.booking.contractNumber ? ` · kontrak ${r.booking.contractNumber}` : ""}
            </p>
          )}
        </div>
        <p className="text-xs text-brand-700/60">
          Diajukan {r.requestedBy.name} · {fmtDateTime(r.requestedAt)}
        </p>
      </div>

      {r.type === "CHANGE_START_DATE" && (
        <p className="mt-2">
          Tanggal mulai <b>{fmtDay(p.previousStartDate ?? r.booking.startDate)}</b> → <b>{fmtDay(p.newStartDate)}</b>
          {p.assetCode ? (
            <>
              {" "}
              · pindah unit <b>{p.previousAssetCode ?? r.booking.assetCode}</b> → <b>{p.assetCode}</b>
            </>
          ) : null}
          {p.signedContract === "RESIGN" ? " · kontrak ditandatangani ulang" : p.signedContract === "RECONFIRM" ? " · kontrak dikonfirmasi ulang" : ""}
        </p>
      )}
      <p className="mt-1 text-brand-700/80">Alasan: {r.reason}</p>
      {r.status === "PENDING" && r.unitFree === false && (
        <p className="mt-2 rounded bg-red-50 px-3 py-2 text-red-700">
          Unit yang diminta tidak lagi kosong untuk tanggal ini — persetujuan akan ditolak. Pengaju perlu memilih unit atau tanggal lain.
        </p>
      )}

      {r.status !== "PENDING" && (
        <p className="mt-2 text-xs text-brand-700/60">
          {CHANGE_STATUS_LABEL[r.status]}
          {r.decidedBy ? ` oleh ${r.decidedBy.name}` : ""} · {fmtDateTime(r.decidedAt)}
          {r.decisionNote ? ` — ${r.decisionNote}` : ""}
        </p>
      )}
      {r.status === "APPROVED" && result && r.type === "CHANGE_START_DATE" && (
        <p className="mt-1 text-xs text-brand-700/60">
          {result.voidedInvoices?.length ? `Invoice dibatalkan: ${result.voidedInvoices.map((i) => i.invoiceNumber).join(", ")}. ` : ""}
          {result.issuedInvoices?.length ? `Diterbitkan ulang: ${result.issuedInvoices.map((i) => i.invoiceNumber).join(", ")}. ` : ""}
          {result.contract ? `Kontrak versi ${result.contract.version}${result.contract.signed === "RESIGN_REQUIRED" ? " — perlu tanda tangan ulang" : result.contract.signed === "RECONFIRM_REQUIRED" ? " — perlu konfirmasi ulang" : ""}.` : ""}
        </p>
      )}

      {r.status === "PENDING" && (r.canDecide || r.canWithdraw || r.cannotDecideReason) && (
        <div className="mt-3 space-y-2">
          {r.cannotDecideReason === "SELF_DECISION" && <p className="text-xs text-brand-700/60">Ini permintaan Anda — orang lain yang harus memutuskannya.</p>}
          {r.canDecide && rejecting && (
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="w-full rounded border border-brand-600/20 px-2 py-1.5" placeholder="Alasan penolakan (wajib)" />
          )}
          <div className="flex flex-wrap gap-1.5">
            {r.canDecide && !rejecting && (
              <>
                <button onClick={() => decide("APPROVE")} disabled={busy} className="rounded bg-brand-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                  Setujui
                </button>
                <button onClick={() => setRejecting(true)} disabled={busy} className="rounded border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-50">
                  Tolak
                </button>
              </>
            )}
            {r.canDecide && rejecting && (
              <>
                <button onClick={() => decide("REJECT")} disabled={busy || note.trim().length < 3} className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                  Tolak permintaan
                </button>
                <button onClick={() => setRejecting(false)} disabled={busy} className="rounded border border-brand-600/20 px-3 py-1.5 text-xs">
                  Batal
                </button>
              </>
            )}
            {r.canWithdraw && (
              <button onClick={withdraw} disabled={busy} className="rounded border border-brand-600/20 px-3 py-1.5 text-xs disabled:opacity-50">
                Tarik permintaan
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
  if (!rows) return <p className="text-sm text-brand-700/60">Memuat permintaan…</p>;
  if (rows.length === 0) return <p className="text-sm text-brand-700/60">Belum ada permintaan perubahan.</p>;
  const pending = rows.filter((r) => r.status === "PENDING");
  const done = rows.filter((r) => r.status !== "PENDING");
  return (
    <div className="space-y-2" data-testid="change-request-panel">
      {pending.map((r) => (
        <ChangeRequestCard key={r.id} request={r} onChanged={load} showBooking={!bookingId} />
      ))}
      {done.length > 0 && (
        <details open={pending.length === 0}>
          <summary className="cursor-pointer text-xs text-brand-700/60">Riwayat permintaan ({done.length})</summary>
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
