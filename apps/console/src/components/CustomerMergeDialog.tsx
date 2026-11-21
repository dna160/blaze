"use client";

import type { ClientListItem } from "@rentos/contracts";
import { useState } from "react";

import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

/**
 * PRD go-live 2 §7.2 — "Gabungkan pelanggan / Merge customers", on the client
 * page, for a super admin. The page's customer is the SURVIVOR: staff find the
 * duplicate, read the dry-run summary (what moves, what changes), then confirm.
 */

interface MergePlan {
  survivor: { id: string; customerNumber: number | null; fullName: string | null; phone: string | null; email: string | null; kycStatus: string };
  duplicate: { id: string; customerNumber: number | null; fullName: string | null; phone: string | null; email: string | null; kycStatus: string };
  moves: Record<string, number>;
  outcomes: string[];
  aliasNumbers: number[];
  applied: boolean;
}

const MOVE_LABELS: Record<string, string> = {
  bookings: "Sewa (booking)",
  rentalOrders: "Pesanan sewa",
  contracts: "Kontrak",
  invoices: "Invoice",
  payments: "Pembayaran",
  deposits: "Deposit",
  depositEvents: "Riwayat deposit",
  changeRequests: "Permintaan perubahan",
  kycDocuments: "Dokumen KYC",
  kycRequests: "Permintaan KYC",
  phones: "Nomor tambahan",
  accessTokens: "Tautan masuk pelanggan",
  legacyRecords: "Arsip Booqable",
  notifications: "Riwayat pesan",
  waitlistEntries: "Daftar tunggu",
  masterAgreements: "Perjanjian induk",
};

function who(c: { customerNumber: number | null; fullName: string | null; phone: string | null }) {
  return `#${c.customerNumber ?? "-"} ${c.fullName ?? "(tanpa nama)"}${c.phone ? ` · ${c.phone}` : ""}`;
}

export function CustomerMergeDialog({ survivorId, survivorLabel, onMerged }: { survivorId: string; survivorLabel: string; onMerged: () => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientListItem[] | null>(null);
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function reset() {
    setQuery("");
    setResults(null);
    setPlan(null);
    setError(null);
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<{ items: ClientListItem[] }>(`/customers/clients?search=${encodeURIComponent(query.trim())}&pageSize=10`, { token: authClient.getToken() });
      setResults(r.items.filter((i) => i.id !== survivorId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Pencarian gagal.");
    } finally {
      setBusy(false);
    }
  }

  async function preview(duplicateId: string) {
    setBusy(true);
    setError(null);
    try {
      setPlan(await apiFetch<MergePlan>(`/customers/${survivorId}/merge`, { token: authClient.getToken(), method: "POST", body: { duplicateId } }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ringkasan penggabungan gagal dimuat.");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!plan) return;
    if (!window.confirm(`Gabungkan ${who(plan.duplicate)} ke ${who(plan.survivor)}? Pelanggan duplikat akan dihapus dan tidak bisa dikembalikan.`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<MergePlan>(`/customers/${survivorId}/merge`, { token: authClient.getToken(), method: "POST", body: { duplicateId: plan.duplicate.id, apply: true } });
      setDone(`Pelanggan ${who(r.duplicate)} sudah digabung ke ${who(r.survivor)}.`);
      setOpen(false);
      reset();
      onMerged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Penggabungan gagal.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="customer-merge">
      {done && <p className="mb-2 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{done}</p>}
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="rounded border border-brand-600/20 px-3 py-1.5 text-sm hover:bg-brand-700/5">
          Gabungkan pelanggan
        </button>
      ) : (
        <div className="rounded-lg border border-amber-300 bg-amber-50/40 p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="font-medium">Gabungkan pelanggan</h3>
              <p className="text-xs text-brand-700/70">
                Pelanggan ini ({survivorLabel}) dipertahankan. Semua sewa, invoice, deposit, dokumen dan riwayat dari pelanggan duplikat dipindahkan ke sini, lalu duplikat dihapus. Nomor pelanggan duplikat tetap bisa dicari.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                reset();
              }}
              className="text-sm text-brand-700/60 hover:underline"
            >
              Tutup
            </button>
          </div>

          {!plan && (
            <>
              <form onSubmit={search} className="mt-3 flex gap-2">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Cari duplikat: nama, nomor HP, email, atau #nomor pelanggan"
                  className="w-full rounded border border-brand-600/20 px-2 py-1.5 text-sm"
                />
                <button type="submit" disabled={busy || !query.trim()} className="rounded bg-brand-700 px-3 py-1.5 text-sm text-white disabled:opacity-40">
                  Cari
                </button>
              </form>
              {results && results.length === 0 && <p className="mt-2 text-sm text-brand-700/60">Tidak ada pelanggan lain yang cocok.</p>}
              {results && results.length > 0 && (
                <ul className="mt-2 divide-y divide-brand-600/10 rounded border border-brand-600/10 bg-white text-sm">
                  {results.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <span>
                        {who({ customerNumber: c.customerNumber ?? null, fullName: c.fullName, phone: c.phone })}
                        {c.units.length ? ` · ${c.units.map((u) => u.code ?? u.assetTypeName).join(", ")}` : ""}
                      </span>
                      <button type="button" disabled={busy} onClick={() => preview(c.id)} className="rounded border border-brand-600/20 px-2 py-1 text-xs hover:bg-brand-700/5">
                        Lihat ringkasan
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {plan && (
            <div className="mt-3 space-y-3 text-sm" data-testid="merge-plan">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded border border-emerald-300 bg-white p-2">
                  <div className="text-xs text-brand-700/60">Dipertahankan</div>
                  <div className="font-medium">{who(plan.survivor)}</div>
                  <div className="text-xs">KYC: {plan.survivor.kycStatus}</div>
                </div>
                <div className="rounded border border-red-300 bg-white p-2">
                  <div className="text-xs text-brand-700/60">Digabung lalu dihapus</div>
                  <div className="font-medium">{who(plan.duplicate)}</div>
                  <div className="text-xs">KYC: {plan.duplicate.kycStatus}</div>
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-brand-700/70">Yang dipindahkan</div>
                <ul className="mt-1 grid grid-cols-2 gap-x-4 sm:grid-cols-3">
                  {Object.entries(plan.moves)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => (
                      <li key={k}>
                        {MOVE_LABELS[k] ?? k}: <b>{n}</b>
                      </li>
                    ))}
                  {Object.values(plan.moves).every((n) => n === 0) && <li>Tidak ada data yang dipindahkan.</li>}
                </ul>
              </div>
              {plan.outcomes.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-brand-700/70">Perubahan pada pelanggan yang dipertahankan</div>
                  <ul className="mt-1 list-disc pl-5">
                    {plan.outcomes.map((o) => (
                      <li key={o}>{o}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex gap-2">
                <button type="button" disabled={busy} onClick={apply} className="rounded bg-red-600 px-3 py-1.5 text-white disabled:opacity-40">
                  Gabungkan sekarang
                </button>
                <button type="button" disabled={busy} onClick={() => setPlan(null)} className="rounded border border-brand-600/20 px-3 py-1.5">
                  Pilih pelanggan lain
                </button>
              </div>
            </div>
          )}
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
