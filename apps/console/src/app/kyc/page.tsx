"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, apiFetchBlob, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

interface KycDocumentWithCustomer {
  id: string;
  documentType: "KTP" | "SELFIE";
  status: "PENDING_REVIEW" | "VERIFIED" | "REJECTED";
  createdAt: string;
  customer: { id: string; fullName: string | null; phone: string };
  verificationSource: "MANUAL" | "AUTO";
  providerReason: string | null;
}

/** PRD §7.2.1 / §8.4 automation A9: manual KYC review queue. */
export default function KycReviewPage() {
  const router = useRouter();
  const [documents, setDocuments] = useState<KycDocumentWithCustomer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const docs = await apiFetch<KycDocumentWithCustomer[]>("/kyc/documents?status=PENDING_REVIEW", { token });
      setDocuments(docs);
    } catch {
      router.push("/login");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function preview(id: string) {
    try {
      const blob = await apiFetchBlob(`/kyc/documents/${id}/file`, authClient.getToken());
      window.open(URL.createObjectURL(blob), "_blank");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load document.");
    }
  }

  async function review(id: string, status: "VERIFIED" | "REJECTED") {
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/kyc/documents/${id}/review`, { token: authClient.getToken(), method: "POST", body: { status } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Review failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ConsoleShell>
      <h1 className="text-2xl font-semibold">KYC Review</h1>
      <p className="mt-1 text-sm text-brand-700/60">
        Documents awaiting verification. A customer is fully verified once every submitted document is approved.
      </p>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {!documents ? (
        <p className="mt-6">Loading...</p>
      ) : documents.length === 0 ? (
        <p className="mt-6 text-brand-700/60">Nothing pending — queue is clear.</p>
      ) : (
        <div className="mt-6 space-y-4">
          {documents.map((doc) => (
            <div key={doc.id} className="flex items-center justify-between rounded-lg border border-brand-600/10 bg-white p-5">
              <div>
                <p className="font-medium">{doc.customer.fullName ?? doc.customer.phone}</p>
                <p className="text-sm text-brand-700/60">
                  {doc.documentType} · submitted {new Date(doc.createdAt).toLocaleDateString("id-ID")}
                </p>
                {doc.providerReason && (
                  <p className="mt-1 text-xs text-amber-700">
                    Automated check inconclusive — needs manual review: {doc.providerReason}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => preview(doc.id)}
                  className="rounded border border-brand-600/20 px-3 py-2 text-sm font-medium hover:bg-brand-700/5"
                >
                  View
                </button>
                <button
                  onClick={() => review(doc.id, "VERIFIED")}
                  disabled={busyId === doc.id}
                  className="rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  Verify
                </button>
                <button
                  onClick={() => review(doc.id, "REJECTED")}
                  disabled={busyId === doc.id}
                  className="rounded border border-red-300 px-4 py-2 text-sm font-medium text-red-600 disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </ConsoleShell>
  );
}
