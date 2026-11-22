"use client";

import { useState } from "react";

import { apiUpload, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/lib/i18n";

/**
 * PRD go-live 2 §5.3 B — staff record a contract the customer signed on paper
 * at the office. The scan is stored as the signed document, as it is — it is
 * never sent to an e-signature service. For a company the director's name is
 * required and the company stamp is recorded (not enforced, §12 Q3).
 * Used on the booking page and the client page.
 */
export function SignedScanUpload({ bookingId, isCompany, onDone }: { bookingId: string; isCompany: boolean; onDone?: () => void }) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [stamp, setStamp] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("signedByName", name.trim());
      if (isCompany) form.append("companyStampPresent", stamp ? "true" : "false");
      form.append("file", file);
      await apiUpload(`/contracts/by-booking/${bookingId}/sign`, authClient.getToken(), form);
      setName("");
      setFile(null);
      onDone?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("scan.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2" data-testid="signed-scan-upload">
      <p className="text-sm font-medium">{t("scan.title")}</p>
      <input
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={isCompany ? t("scan.directorName") : t("scan.signerName")}
        className="w-full rounded border border-brand-600/20 px-2 py-1 text-sm"
      />
      {isCompany && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={stamp} onChange={(e) => setStamp(e.target.checked)} />
          {t("scan.stamp")}
        </label>
      )}
      <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="w-full text-sm" />
      <button type="submit" disabled={busy || !file || !name.trim()} className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
        {busy ? t("scan.uploading") : t("scan.save")}
      </button>
      <p className="text-xs text-brand-700/50">{t("scan.note")}</p>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
