"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { CustomerDto, KycDocumentDto } from "@rentos/contracts";

import { apiFetch, apiUpload, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

const TENANT_SLUG = process.env.NEXT_PUBLIC_DEV_TENANT_SLUG ?? "";

const STATUS_LABEL: Record<string, string> = {
  NOT_SUBMITTED: "Not submitted",
  PENDING_REVIEW: "Under review",
  VERIFIED: "Verified",
  REJECTED: "Rejected — please re-upload",
};

/** PRD §7.1.2 step 4 / §7.1.4 "Profile & KYC documents": upload KTP + selfie, tracked per-document, admin-reviewed. */
export default function KycPage() {
  const router = useRouter();
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [documents, setDocuments] = useState<KycDocumentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<"KTP" | "SELFIE" | null>(null);

  async function load() {
    const token = authClient.getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const [me, docs] = await Promise.all([
        apiFetch<CustomerDto>("/customers/me", { tenantSlug: TENANT_SLUG, token }),
        apiFetch<KycDocumentDto[]>("/kyc/documents/mine", { tenantSlug: TENANT_SLUG, token }),
      ]);
      setCustomer(me);
      setDocuments(docs);
    } catch {
      router.push("/portal");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function upload(documentType: "KTP" | "SELFIE", file: File) {
    const token = authClient.getToken();
    if (!token) return;
    setUploading(documentType);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("documentType", documentType);
      formData.append("file", file);
      await apiUpload("/kyc/documents", { tenantSlug: TENANT_SLUG, token, formData });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setUploading(null);
    }
  }

  if (!customer || !documents) return <p>Loading...</p>;

  const latestByType = (type: "KTP" | "SELFIE") => documents.find((d) => d.documentType === type);

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Identity verification</h1>
        <p className="mt-1 text-brand-700/70">Overall status: {STATUS_LABEL[customer.kycStatus]}</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {(["KTP", "SELFIE"] as const).map((type) => {
        const doc = latestByType(type);
        return (
          <div key={type} className="rounded-xl border border-brand-600/10 bg-white p-6">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">{type === "KTP" ? "KTP (ID card)" : "Selfie"}</h3>
              {doc && (
                <span className="rounded-full bg-brand-700/10 px-3 py-1 text-xs font-medium">
                  {STATUS_LABEL[doc.status]}
                </span>
              )}
            </div>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              disabled={uploading === type}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload(type, file);
              }}
              className="mt-3 w-full text-sm"
            />
            {uploading === type && <p className="mt-2 text-xs text-brand-700/60">Uploading...</p>}
            {doc && (
              <p className="mt-2 text-xs text-brand-700/60">
                {doc.status === "REJECTED" ? "Upload a new photo to try again." : "Uploaded — you can replace it anytime before it's verified."}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
