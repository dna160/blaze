"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  KYC_REQUIRED_DOCUMENTS,
  type CustomerDto,
  type KycDocumentDto,
  type KycDocumentTypeValue,
} from "@rentos/contracts";

import { apiFetch, apiUpload, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { getClientTenantSlug } from "@/lib/tenant-client";

const TENANT_SLUG = getClientTenantSlug();

const STATUS_LABEL: Record<string, string> = {
  NOT_SUBMITTED: "Not submitted",
  PENDING_REVIEW: "Under review",
  VERIFIED: "Verified",
  VERIFIED_LEGACY: "Verified",
  REJECTED: "Rejected — please re-upload",
};

const DOCUMENT_LABEL: Record<KycDocumentTypeValue, { title: string; hint: string }> = {
  KTP: { title: "KTP (ID card)", hint: "The signatory's Indonesian ID card." },
  SELFIE: { title: "Selfie", hint: "A photo of the signatory holding their KTP." },
  NIB: { title: "NIB", hint: "Nomor Induk Berusaha — the company's business registration." },
  NPWP: { title: "NPWP", hint: "The company's tax registration card." },
  PPH_SUPPORT: {
    title: "PPh supporting document",
    hint: "Optional — a bukti potong, SKB or similar. Never required to finish verification.",
  },
};

/**
 * PRD §7.1.2 step 4 / §7.1.4 "Profile & KYC documents".
 *
 * The document set depends on the customer type: an individual shows a KTP and
 * a selfie, a company adds its NIB and NPWP on top of the signatory's. The
 * required list comes from KYC_REQUIRED_DOCUMENTS rather than being spelled out
 * here, so this checklist cannot promise a different bar from the one the API
 * enforces when it recomputes the customer's status.
 *
 * A company is also asked whether PPh is withheld. That answer is stored on the
 * customer because invoicing needs it; the supporting file is optional evidence
 * for staff and deliberately never blocks verification.
 */
export default function KycPage() {
  const router = useRouter();
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [documents, setDocuments] = useState<KycDocumentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<KycDocumentTypeValue | null>(null);
  const [savingPph, setSavingPph] = useState(false);
  const [pphSaved, setPphSaved] = useState(false);

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

  async function upload(documentType: KycDocumentTypeValue, file: File) {
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

  async function savePph(pphWithheld: boolean) {
    const token = authClient.getToken();
    if (!token) return;
    setSavingPph(true);
    setError(null);
    try {
      await apiFetch("/customers/me/tax-profile", {
        tenantSlug: TENANT_SLUG,
        token,
        method: "PATCH",
        body: { pphWithheld },
      });
      setPphSaved(true);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save your answer.");
    } finally {
      setSavingPph(false);
    }
  }

  if (!customer || !documents) return <p>Loading...</p>;

  const isCompany = customer.type === "BUSINESS";
  const required = KYC_REQUIRED_DOCUMENTS[customer.type];
  // The optional PPh slip is offered to companies only, after the required set.
  const shown: KycDocumentTypeValue[] = isCompany ? [...required, "PPH_SUPPORT"] : [...required];
  const latestByType = (type: KycDocumentTypeValue) => documents.find((d) => d.documentType === type);

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Identity verification</h1>
        <p className="mt-1 text-brand-700/70">Overall status: {STATUS_LABEL[customer.kycStatus]}</p>
        {isCompany && (
          <p className="mt-1 text-sm text-brand-700/60">
            Verifying {customer.companyName ?? "your company"} as a company rental.
          </p>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {isCompany && (
        <div className="rounded-xl border border-brand-600/10 bg-white p-6">
          <h3 className="font-medium">Apakah akan memotong PPh?</h3>
          <p className="mt-1 text-sm text-brand-700/60">
            Will your company withhold income tax (PPh) when paying this rental? If you are not sure, ask your finance
            team — we can change this later.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {([
              { value: true, label: "Ya", sub: "Yes, we will withhold" },
              { value: false, label: "Tidak", sub: "No, we pay in full" },
            ] as const).map((option) => (
              <button
                key={String(option.value)}
                type="button"
                disabled={savingPph}
                aria-pressed={customer.pphWithheld === option.value}
                onClick={() => savePph(option.value)}
                className={`rounded border px-3 py-2 text-sm disabled:opacity-50 ${
                  customer.pphWithheld === option.value
                    ? "border-brand-700 bg-brand-700 text-white"
                    : "border-brand-600/20 text-brand-700/70 hover:bg-brand-700/5"
                }`}
              >
                {option.label}
                <span
                  className={`block text-xs ${
                    customer.pphWithheld === option.value ? "text-white/70" : "text-brand-700/50"
                  }`}
                >
                  {option.sub}
                </span>
              </button>
            ))}
          </div>
          {customer.pphWithheld === null && !pphSaved && (
            <p className="mt-2 text-xs text-brand-700/60">Not answered yet.</p>
          )}
          {customer.pphWithheld !== null && (
            <p className="mt-2 text-xs text-brand-700/60">
              Saved. Attach a supporting document below if you have one — it is optional.
            </p>
          )}
        </div>
      )}

      {shown.map((type) => {
        const doc = latestByType(type);
        const optional = !required.includes(type);
        const label = DOCUMENT_LABEL[type];
        return (
          <div key={type} className="rounded-xl border border-brand-600/10 bg-white p-6">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">
                {label.title}
                {optional && <span className="ml-2 text-xs font-normal text-brand-700/50">Optional</span>}
              </h3>
              {doc && (
                <span className="rounded-full bg-brand-700/10 px-3 py-1 text-xs font-medium">
                  {STATUS_LABEL[doc.status]}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-brand-700/60">{label.hint}</p>
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
                {doc.status === "REJECTED"
                  ? "Upload a new file to try again."
                  : "Uploaded — you can replace it anytime before it's verified."}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
