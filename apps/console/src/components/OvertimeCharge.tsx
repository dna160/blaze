"use client";

import { useEffect, useState } from "react";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

/**
 * PRD go-live 2 §10.3 (T&C II.8) — staff record access outside opening hours
 * on the booking page: hours × the branch's hourly rate, added to the next
 * scheduled invoice or billed as a one-off invoice. Hidden while the branch
 * has the rule off.
 */
export function OvertimeCharge({ bookingId, onCharged }: { bookingId: string; onCharged?: () => void }) {
  const [rate, setRate] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState("1");
  const [date, setDate] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" }));
  const [note, setNote] = useState("");
  const [target, setTarget] = useState<"NEXT_INVOICE" | "ONE_OFF">("NEXT_INVOICE");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    apiFetch<{ overtime: { enabled: boolean; hourlyRate: number } }>("/money-rules/config", { token: authClient.getToken() })
      .then((c) => setRate(c.overtime.enabled ? c.overtime.hourlyRate : null))
      .catch(() => setRate(null));
  }, []);

  if (rate === null) return null;
  const h = Number(hours);
  const total = Number.isFinite(h) && h > 0 ? Math.round(h * rate) : 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiFetch<{ invoiceNumber: string; amount: number; target: string }>(`/money-rules/bookings/${bookingId}/overtime`, {
        token: authClient.getToken(),
        method: "POST",
        body: { hours: h, date, note: note.trim() || null, target },
      });
      setMsg({ ok: true, text: `Biaya Rp ${r.amount.toLocaleString("id-ID")} ditambahkan ke invoice ${r.invoiceNumber}${r.target === "ONE_OFF" ? " (invoice tersendiri)" : ""}.` });
      setOpen(false);
      onCharged?.();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : "Gagal menambahkan biaya." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3" data-testid="overtime-charge">
      {msg && <p className={`mb-2 text-sm ${msg.ok ? "text-green-700" : "text-red-600"}`}>{msg.text}</p>}
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="rounded border border-brand-600/20 px-3 py-1.5 text-sm hover:bg-brand-700/5">
          Tambah biaya akses di luar jam
        </button>
      ) : (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3 rounded border border-brand-600/15 bg-white p-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-brand-700/60">Tanggal</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded border border-brand-600/20 px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-brand-700/60">Jam</span>
            <input type="number" min={0.5} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} className="w-20 rounded border border-brand-600/20 px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-brand-700/60">Catatan</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="mis. ambil barang 20.00–22.00" className="w-56 rounded border border-brand-600/20 px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-brand-700/60">Ditagihkan</span>
            <select value={target} onChange={(e) => setTarget(e.target.value as "NEXT_INVOICE" | "ONE_OFF")} className="rounded border border-brand-600/20 px-2 py-1">
              <option value="NEXT_INVOICE">di invoice berikutnya</option>
              <option value="ONE_OFF">invoice tersendiri</option>
            </select>
          </label>
          <span className="text-xs text-brand-700/70">
            {hours} jam × Rp {rate.toLocaleString("id-ID")} = <b>Rp {total.toLocaleString("id-ID")}</b>
          </span>
          <button type="submit" disabled={busy || total <= 0} className="rounded bg-brand-700 px-3 py-1.5 text-white disabled:opacity-40">
            Tambahkan
          </button>
          <button type="button" onClick={() => setOpen(false)} className="text-brand-700/60 hover:underline">
            Batal
          </button>
        </form>
      )}
    </div>
  );
}
