"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ChangeRequestDto } from "@rentos/contracts";

import { ChangeRequestCard } from "@/components/ChangeRequests";
import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { CHANGE_TYPE_LABEL, useChangeRequestSummary } from "@/lib/change-requests";

/**
 * PRD go-live 2 §4.1 — "Permintaan": booking changes waiting for a decision,
 * and what was decided. Staff file requests from the booking page, the
 * workbench card or the client page; whoever the organization's approval
 * policy names decides here (never their own request).
 */
export default function ChangeRequestsPage() {
  const router = useRouter();
  const summary = useChangeRequestSummary();
  const [tab, setTab] = useState<"PENDING" | "HISTORY">("PENDING");
  const [rows, setRows] = useState<ChangeRequestDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    setError(null);
    try {
      setRows(await apiFetch<ChangeRequestDto[]>(`/change-requests?status=${tab}`, { token }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gagal memuat permintaan.");
    }
  }, [router, tab]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  const mine = rows?.filter((r) => r.canDecide) ?? [];
  const others = rows?.filter((r) => !r.canDecide) ?? [];

  return (
    <ConsoleShell>
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Permintaan</h1>
          <p className="text-sm text-brand-700/70">
            Pembatalan dan perubahan tanggal mulai booking yang diajukan staf. Yang mengajukan tidak bisa menyetujui permintaannya sendiri.
          </p>
          {summary.approvableTypes.length > 0 ? (
            <p className="mt-1 text-xs text-brand-700/60">Anda dapat memutuskan: {summary.approvableTypes.map((t) => CHANGE_TYPE_LABEL[t]).join(", ")}.</p>
          ) : (
            <p className="mt-1 text-xs text-brand-700/60">Anda dapat mengajukan dan memantau permintaan; keputusannya diambil supervisor, admin, atau Super Admin.</p>
          )}
        </div>

        <div className="flex gap-1.5">
          {(["PENDING", "HISTORY"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} aria-pressed={tab === t} className={`rounded px-3 py-1.5 text-sm ${tab === t ? "bg-brand-700 text-white" : "border border-brand-600/15 hover:bg-brand-700/5"}`}>
              {t === "PENDING" ? "Menunggu keputusan" : "Riwayat"}
            </button>
          ))}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {!rows && !error && <p className="text-sm text-brand-700/60">Memuat…</p>}
        {rows && rows.length === 0 && <p className="text-sm text-brand-700/60">{tab === "PENDING" ? "Tidak ada permintaan yang menunggu keputusan." : "Belum ada riwayat permintaan."}</p>}

        {rows && tab === "PENDING" && mine.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-brand-700/80">Menunggu keputusan Anda ({mine.length})</h2>
            {mine.map((r) => (
              <ChangeRequestCard key={r.id} request={r} onChanged={load} />
            ))}
          </section>
        )}
        {rows && tab === "PENDING" && others.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-brand-700/80">Menunggu keputusan orang lain ({others.length})</h2>
            {others.map((r) => (
              <ChangeRequestCard key={r.id} request={r} onChanged={load} />
            ))}
          </section>
        )}
        {rows && tab === "HISTORY" && rows.map((r) => <ChangeRequestCard key={r.id} request={r} onChanged={load} />)}
      </div>
    </ConsoleShell>
  );
}
