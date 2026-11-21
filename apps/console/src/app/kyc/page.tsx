"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { KYC_DOCUMENT_LABELS, type KycDocumentTypeValue, type KycRequestDto } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, apiFetchBlob, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

const DOC_STATUS: Record<string, { label: string; style: string }> = {
  PENDING_REVIEW: { label: "Menunggu", style: "bg-amber-100 text-amber-800" },
  VERIFIED: { label: "Terverifikasi", style: "bg-green-100 text-green-800" },
  VERIFIED_LEGACY: { label: "Terverifikasi", style: "bg-green-100 text-green-800" },
  REJECTED: { label: "Ditolak", style: "bg-red-100 text-red-700" },
};

const REQUEST_STATUS: Record<string, { label: string; style: string }> = {
  OPEN: { label: "Menunggu dokumen", style: "bg-amber-100 text-amber-800" },
  COMPLETE: { label: "Lengkap — siap diverifikasi", style: "bg-blue-100 text-blue-800" },
  VERIFIED: { label: "Terverifikasi", style: "bg-green-100 text-green-800" },
  REJECTED: { label: "Ditolak", style: "bg-red-100 text-red-700" },
};

const CHANNEL: Record<string, string> = {
  WHATSAPP: "diminta via WhatsApp",
  STAFF: "diterima staf di kantor",
  PORTAL: "dimulai pelanggan di portal",
  BACKFILL: "dokumen sebelum fitur ini",
};

function label(type: string): string {
  return KYC_DOCUMENT_LABELS[type as KycDocumentTypeValue]?.id ?? type;
}
function fmt(value: string | null): string {
  return value ? new Date(value).toLocaleString("id-ID", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

/** An image thumbnail, fetched with the staff token (each open is audited by the API). */
function Thumb({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [pdf, setPdf] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    apiFetchBlob(`/kyc/documents/${id}/file`, authClient.getToken())
      .then((blob) => {
        if (blob.type === "application/pdf") setPdf(true);
        else {
          url = URL.createObjectURL(blob);
          setSrc(url);
        }
      })
      .catch(() => setSrc(null));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  return (
    <button type="button" onClick={() => onOpen(id)} className="flex h-20 w-28 items-center justify-center overflow-hidden rounded border border-brand-600/15 bg-brand-700/5 text-xs text-brand-700/60" title="Lihat">
      {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : pdf ? "PDF" : "…"}
    </button>
  );
}

/**
 * PRD go-live 2 §5.2 — KYC review works on requests (batches), one card per
 * request: who, which booking, what was asked and when, what came back, what
 * is missing, the company's PPh answer, then Verify all or Reject with a
 * reason that is sent to the customer. Decided requests stay under Riwayat.
 */
export default function KycReviewPage() {
  const router = useRouter();
  const [tab, setTab] = useState<"review" | "history">("review");
  const [requests, setRequests] = useState<KycRequestDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  async function load(which = tab) {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    setRequests(null);
    try {
      setRequests(await apiFetch<KycRequestDto[]>(`/kyc/requests?tab=${which}`, { token }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) router.push("/login");
      setError(err instanceof ApiError ? err.message : "Gagal memuat.");
      setRequests([]);
    }
  }

  useEffect(() => {
    void load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function open(id: string) {
    try {
      const blob = await apiFetchBlob(`/kyc/documents/${id}/file`, authClient.getToken());
      window.open(URL.createObjectURL(blob), "_blank", "noopener");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Dokumen tidak dapat dibuka.");
    }
  }

  async function decide(id: string, decision: "VERIFIED" | "REJECTED") {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/kyc/requests/${id}/decide`, { token: authClient.getToken(), method: "POST", body: decision === "REJECTED" ? { decision, reason } : { decision } });
      setNotice(decision === "VERIFIED" ? "Terverifikasi." : "Ditolak — alasan dikirim ke pelanggan.");
      setRejecting(null);
      setReason("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gagal.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">Verifikasi KYC</h1>
      <p className="mt-1 text-sm text-brand-700/60">Satu kartu per permintaan KYC. Membuka dokumen tercatat di log audit.</p>
      <div className="mt-4 flex gap-2" role="tablist">
        {(["review", "history"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded px-3 py-1.5 text-sm ${tab === t ? "bg-brand-700 text-white" : "border border-brand-600/15"}`}>
            {t === "review" ? "Perlu ditinjau" : "Riwayat"}
          </button>
        ))}
      </div>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      {notice && <p className="mt-4 text-sm text-green-700">{notice}</p>}

      {!requests ? (
        <p className="mt-6">Memuat…</p>
      ) : requests.length === 0 ? (
        <p className="mt-6 text-brand-700/60">{tab === "review" ? "Tidak ada yang perlu ditinjau." : "Belum ada riwayat."}</p>
      ) : (
        <div className="mt-6 space-y-4">
          {requests.map((r) => {
            const st = REQUEST_STATUS[r.status] ?? { label: r.status, style: "" };
            const company = r.customer.type === "BUSINESS";
            const docs = r.documents.filter((d) => tab === "history" || d.latest);
            return (
              <article key={r.id} className="rounded-lg border border-brand-600/10 bg-white p-5" data-testid="kyc-request-card">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <Link href={`/clients/${r.customer.id}`} className="font-medium hover:underline">
                      {company && r.customer.companyName ? r.customer.companyName : (r.customer.fullName ?? r.customer.phone)}
                    </Link>
                    {r.customer.customerNumber !== null && <span className="ml-2 text-xs text-brand-700/50">#{r.customer.customerNumber}</span>}
                    {company && <span className="ml-2 rounded-full bg-brand-700/10 px-2 py-0.5 text-xs">Perusahaan</span>}
                    {company && r.customer.fullName && <p className="text-xs text-brand-700/50">Penandatangan: {r.customer.fullName}</p>}
                    <p className="text-xs text-brand-700/60">
                      {r.booking ? (
                        <Link href={`/bookings/${r.booking.id}`} className="hover:underline">
                          Pemesanan {r.booking.unitTypeName ?? ""}
                          {r.booking.unitCode ? ` — ${r.booking.unitCode}` : ""} · mulai {new Date(r.booking.startDate).toLocaleDateString("id-ID")}
                        </Link>
                      ) : (
                        "Tanpa pemesanan"
                      )}
                    </p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-medium ${st.style}`}>{st.label}</span>
                </div>

                <p className="mt-2 text-sm">
                  <span className="text-brand-700/60">Diminta:</span> {r.requestedTypes.map(label).join(", ")} · {fmt(r.requestedAt)} · {CHANNEL[r.channel] ?? r.channel}
                  {r.requestedByName ? ` · oleh ${r.requestedByName}` : ""}
                </p>
                {r.missing.length > 0 && (
                  <p className="mt-1 text-sm text-amber-800">
                    <span className="text-brand-700/60">Masih kurang:</span> {r.missing.map(label).join(", ")}
                  </p>
                )}
                {company && (
                  <p className="mt-1 text-sm">
                    <span className="text-brand-700/60">Memotong PPh?</span>{" "}
                    <b>{r.customer.pphWithheld === null ? "belum dijawab" : r.customer.pphWithheld ? "Ya" : "Tidak"}</b>
                  </p>
                )}

                <div className="mt-3 flex flex-wrap gap-3">
                  {docs.length === 0 && <p className="text-sm text-brand-700/50">Belum ada dokumen yang masuk.</p>}
                  {docs.map((d) => (
                    <figure key={d.id} className="space-y-1 text-xs">
                      <Thumb id={d.id} onOpen={(id) => void open(id)} />
                      <figcaption>
                        <b>{label(d.documentType)}</b>{" "}
                        <span className={`rounded-full px-1.5 py-0.5 ${DOC_STATUS[d.status]?.style ?? ""}`}>{DOC_STATUS[d.status]?.label ?? d.status}</span>
                        <span className="block text-brand-700/50">
                          {d.channel === "STAFF" ? "staf" : "pelanggan"} · {new Date(d.createdAt).toLocaleDateString("id-ID")}
                        </span>
                      </figcaption>
                    </figure>
                  ))}
                </div>

                {tab === "history" ? (
                  <p className="mt-3 text-sm text-brand-700/60">
                    Diputuskan {fmt(r.decidedAt)}
                    {r.decidedByName ? ` oleh ${r.decidedByName}` : ""}
                    {r.decisionReason ? ` — alasan: ${r.decisionReason}` : ""}
                  </p>
                ) : rejecting === r.id ? (
                  <div className="mt-3 space-y-2 border-t border-brand-600/10 pt-3">
                    <label className="block text-sm">
                      Alasan penolakan (dikirim ke pelanggan)
                      <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="mt-1 w-full rounded border border-brand-600/20 px-2 py-1 text-sm" />
                    </label>
                    <div className="flex gap-2">
                      <button onClick={() => void decide(r.id, "REJECTED")} disabled={busyId === r.id || reason.trim().length < 3} className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
                        Tolak dan kirim alasan
                      </button>
                      <button onClick={() => setRejecting(null)} className="rounded border border-brand-600/20 px-3 py-1.5 text-sm">
                        Batal
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex gap-2 border-t border-brand-600/10 pt-3">
                    <button
                      onClick={() => void decide(r.id, "VERIFIED")}
                      disabled={busyId === r.id || r.missing.length > 0}
                      title={r.missing.length > 0 ? "Dokumen belum lengkap" : undefined}
                      className="rounded bg-green-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                    >
                      Verifikasi semua
                    </button>
                    <button
                      onClick={() => {
                        setRejecting(r.id);
                        setReason("");
                      }}
                      disabled={busyId === r.id}
                      className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-600"
                    >
                      Tolak…
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </ConsoleShell>
  );
}
