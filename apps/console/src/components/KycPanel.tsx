"use client";

import { useEffect, useState } from "react";
import { KYC_DOCUMENT_LABELS, type CustomerKycSummary, type KycDocumentTypeValue } from "@rentos/contracts";

import { apiFetch, apiFetchBlob, apiUpload, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { canDo } from "@/lib/capabilities";
import { getLocale, hasMessage, tr, useT } from "@/lib/i18n";

const statusLabel = (s: string) => (hasMessage(`kycPanel.status.${s}`) ? tr(`kycPanel.status.${s}`) : s);

const STATUS_STYLE: Record<string, string> = {
  PENDING_REVIEW: "bg-amber-100 text-amber-800",
  VERIFIED: "bg-green-100 text-green-800",
  VERIFIED_LEGACY: "bg-green-100 text-green-800",
  REJECTED: "bg-red-100 text-red-700",
};

function label(type: string): string {
  return KYC_DOCUMENT_LABELS[type as KycDocumentTypeValue]?.[getLocale()] ?? type;
}

/**
 * PRD go-live 2 §5.1 — staff-assisted KYC for a walk-in. Shown on the client
 * page and the booking page: what is on file, what is still missing, an
 * upload per document type (staff take the files at the counter), then either
 * "Minta kekurangan via WhatsApp" (the customer is asked for exactly what is
 * missing) or "Verifikasi sekarang" (an approver verifies on the spot).
 */
export function KycPanel({ customerId, bookingId, onChanged }: { customerId: string; bookingId?: string | null; onChanged?: () => void }) {
  const { t, intl } = useT();
  const user = authClient.getUser();
  const canUpload = canDo(user, "upload_kyc_on_behalf") || canDo(user, "approve_booking");
  const canVerify = canDo(user, "approve_booking");
  const [summary, setSummary] = useState<CustomerKycSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    try {
      setSummary(await apiFetch<CustomerKycSummary>(`/kyc/customers/${customerId}`, { token: authClient.getToken() }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("kycPanel.loadFailed"));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  async function upload(documentType: string, file: File) {
    setBusy(documentType);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("documentType", documentType);
      if (bookingId) form.append("bookingId", bookingId);
      form.append("file", file);
      await apiUpload(`/kyc/customers/${customerId}/documents`, authClient.getToken(), form);
      setNotice(t("kycPanel.uploaded", { type: label(documentType) }));
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("kycPanel.uploadFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function action(path: "request-missing" | "verify", success: string) {
    setBusy(path);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/kyc/customers/${customerId}/${path}`, { token: authClient.getToken(), method: "POST", body: bookingId ? { bookingId } : {} });
      setNotice(success);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("kycPanel.actionFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function view(id: string) {
    try {
      const blob = await apiFetchBlob(`/kyc/documents/${id}/file`, authClient.getToken());
      window.open(URL.createObjectURL(blob), "_blank", "noopener");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("kycPanel.openFailed"));
    }
  }

  if (!summary) {
    return (
      <section className="rounded-lg border border-brand-600/10 bg-white p-5" data-testid="kyc-panel">
        <h2 className="font-medium">{t("kycPanel.title")}</h2>
        <p className="mt-2 text-sm text-brand-700/60">{error ?? t("common.loading")}</p>
      </section>
    );
  }

  const latestByType = new Map(summary.documents.filter((d) => d.latest).map((d) => [d.documentType, d]));
  const verified = summary.kycStatus === "VERIFIED" || summary.kycStatus === "VERIFIED_LEGACY";
  const nothingMissing = summary.missing.length === 0;

  return (
    <section className="rounded-lg border border-brand-600/10 bg-white p-5" data-testid="kyc-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{t("kycPanel.title")}</h2>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLE[summary.kycStatus] ?? "bg-brand-700/10"}`}>
          {statusLabel(summary.kycStatus)}
        </span>
      </div>
      <p className="mt-1 text-xs text-brand-700/60">
        {summary.customerType === "BUSINESS" ? t("kycPanel.company") : t("kycPanel.individual")} · {t("kycPanel.required", { list: summary.required.map(label).join(", ") })}
        {summary.missing.length > 0 ? (
          <span className="text-amber-800"> · {t("kycPanel.missing", { list: summary.missing.map(label).join(", ") })}</span>
        ) : (
          <span className="text-green-800"> · {t("kycPanel.allPresent")}</span>
        )}
      </p>
      {summary.openRequest && (
        <p className="mt-1 text-xs text-brand-700/50">
          {t("kycPanel.openSince", { date: new Date(summary.openRequest.requestedAt).toLocaleDateString(intl) })} ·{" "}
          {summary.openRequest.status === "COMPLETE" ? t("kycPanel.completeWaiting") : t("kycPanel.waitingDocs")}
        </p>
      )}

      <ul className="mt-3 divide-y divide-brand-600/10 text-sm">
        {summary.uploadable.map((type) => {
          const doc = latestByType.get(type);
          const required = summary.required.includes(type);
          return (
            <li key={type} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <span className="font-medium">{label(type)}</span>
                {!required && <span className="ml-2 text-xs text-brand-700/50">{t("kycPanel.optional")}</span>}
                {doc && (
                  <span className="ml-2 text-xs text-brand-700/60">
                    <span className={`rounded-full px-2 py-0.5 ${STATUS_STYLE[doc.status] ?? ""}`}>{statusLabel(doc.status)}</span>{" "}
                    {doc.channel === "STAFF" ? t("kycPanel.byStaff") : t("kycPanel.byCustomer")} · {new Date(doc.createdAt).toLocaleDateString(intl)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {doc && (
                  <button type="button" onClick={() => void view(doc.id)} className="text-xs text-accent-500 underline">
                    {t("kycPanel.view")}
                  </button>
                )}
                {canUpload && !verified && (
                  <label className="cursor-pointer rounded border border-brand-600/20 px-2 py-1 text-xs hover:bg-brand-700/5">
                    {busy === type ? t("kycPanel.uploading") : doc ? t("kycPanel.replace") : t("kycPanel.upload")}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,application/pdf"
                      className="hidden"
                      disabled={busy !== null}
                      aria-label={t("kycPanel.uploadLabel", { type: label(type) })}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (f) void upload(type, f);
                      }}
                    />
                  </label>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {!verified && (canUpload || canVerify) && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-brand-600/10 pt-3">
          {canUpload && (
            <button
              type="button"
              disabled={busy !== null || nothingMissing}
              title={nothingMissing ? t("kycPanel.nothingMissing") : undefined}
              onClick={() => void action("request-missing", t("kycPanel.requestSent"))}
              className="rounded border border-brand-600/20 px-3 py-1.5 text-sm disabled:opacity-40"
            >
              {t("kycPanel.requestMissing")}
            </button>
          )}
          {canVerify && (
            <button
              type="button"
              disabled={busy !== null || !nothingMissing}
              title={!nothingMissing ? t("kycPanel.completeFirst") : undefined}
              onClick={() => void action("verify", t("kycPanel.verifiedNow"))}
              className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {t("kycPanel.verifyNow")}
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {notice && <p className="mt-2 text-sm text-green-700">{notice}</p>}
    </section>
  );
}
