import { z } from "zod";

export const KycStatusSchema = z.enum(["NOT_SUBMITTED", "PENDING_REVIEW", "VERIFIED", "REJECTED", "VERIFIED_LEGACY"]);

/**
 * PRD go-live §10 — a customer imported from the legacy system carries
 * VERIFIED_LEGACY: verified for every gate (they are not asked to redo KYC),
 * but distinguishable from a RentOS-reviewed VERIFIED. Every "is this customer
 * verified?" check goes through here so the two can never drift.
 */
export function isKycVerified(status: string | null | undefined): boolean {
  return status === "VERIFIED" || status === "VERIFIED_LEGACY";
}

export const CustomerChannelSchema = z.enum(["WHATSAPP", "EMAIL"]);
export type CustomerChannelValue = z.infer<typeof CustomerChannelSchema>;

export const CustomerTypeSchema = z.enum(["INDIVIDUAL", "BUSINESS"]);
export type CustomerTypeValue = z.infer<typeof CustomerTypeSchema>;

export const CustomerDtoSchema = z.object({
  id: z.string().uuid(),
  /** Nullable since PRD v2 D3 (Google-signed-in customers are keyed by email). */
  phone: z.string().nullable(),
  email: z.string().email().nullable(),
  fullName: z.string().nullable(),
  type: CustomerTypeSchema,
  companyName: z.string().nullable(),
  taxId: z.string().nullable(),
  nib: z.string().nullable(),
  /** null = the customer has not answered "Apakah dibebankan PPh?" yet. */
  pphWithheld: z.boolean().nullable(),
  kycStatus: KycStatusSchema,
  preferredChannel: CustomerChannelSchema,
  isBlocklisted: z.boolean(),
});
export type CustomerDto = z.infer<typeof CustomerDtoSchema>;

/**
 * Client list (PRD v2 §5.2): "healthy means paid ahead, risky means 7 days
 * before payment is due, overdue means payment is already due, inactive
 * means they are no longer with us."
 */
export const CustomerHealthSchema = z.enum(["HEALTHY", "RISKY", "OVERDUE", "INACTIVE"]);
export type CustomerHealthValue = z.infer<typeof CustomerHealthSchema>;

export const ClientListQuerySchema = z.object({
  /** Matches name, phone, email, or unit code (case-insensitive). */
  search: z.string().max(200).optional(),
  status: CustomerHealthSchema.optional(),
  locationId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ClientListQuery = z.infer<typeof ClientListQuerySchema>;

export const ClientListItemSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  preferredChannel: CustomerChannelSchema,
  kycStatus: KycStatusSchema,
  health: CustomerHealthSchema,
  /** Units currently held (active / approved / pending), e.g. [{ code: "B-14", location: "Kelapa Gading" }]. */
  units: z.array(z.object({ bookingId: z.string().uuid(), code: z.string().nullable(), assetTypeName: z.string(), locationName: z.string().nullable(), status: z.string() })),
  /** Earliest start date among live bookings. */
  moveInDate: z.string().datetime().nullable(),
  nextDueDate: z.string().datetime().nullable(),
  nextDueAmount: z.string().nullable(),
  outstandingAmount: z.string(),
  overdueCount: z.number().int(),
  createdAt: z.string().datetime(),
});
export type ClientListItem = z.infer<typeof ClientListItemSchema>;

export const ClientListResponseSchema = z.object({
  items: z.array(ClientListItemSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  counts: z.object({ HEALTHY: z.number().int(), RISKY: z.number().int(), OVERDUE: z.number().int(), INACTIVE: z.number().int() }),
});
export type ClientListResponse = z.infer<typeof ClientListResponseSchema>;

/**
 * KTP and SELFIE identify the person signing, for every customer — a company
 * still has a PIC, and the liveness check is what stops a stolen KTP being
 * used. NIB and NPWP are the company's registration and tax numbers and are
 * asked for only from a BUSINESS customer.
 *
 * PPH_SUPPORT is the odd one out: it backs the customer's answer to "Apakah
 * dibebankan PPh?" and is always optional, so it never gates verification. See
 * KYC_REQUIRED_DOCUMENTS.
 */
export const KycDocumentTypeSchema = z.enum(["KTP", "PASSPORT", "SELFIE", "NIB", "NPWP", "PPH_SUPPORT"]);
export type KycDocumentTypeValue = z.infer<typeof KycDocumentTypeSchema>;

/**
 * One thing a customer has to prove, and the document types that prove it.
 * `key` is the type we ASK for; `anyOf` is everything that satisfies it — a
 * foreign signatory's passport stands in for a KTP (PRD go-live 2 §5.1).
 */
export interface KycRequirement {
  key: KycDocumentTypeValue;
  anyOf: readonly KycDocumentTypeValue[];
}

const IDENTITY: KycRequirement = { key: "KTP", anyOf: ["KTP", "PASSPORT"] };
const one = (key: KycDocumentTypeValue): KycRequirement => ({ key, anyOf: [key] });

/**
 * What has to be VERIFIED before a customer counts as verified, by customer
 * type. THE single source of truth (PRD go-live 2 §5.1): the API's recompute,
 * the storefront checklist, the staff upload panel, the "request what's
 * missing" message and the review card all read it, so none of them can
 * promise a different bar from the one the server enforces.
 */
export function kycRequirements(customerType: CustomerTypeValue): readonly KycRequirement[] {
  return customerType === "BUSINESS" ? [IDENTITY, one("SELFIE"), one("NIB"), one("NPWP")] : [IDENTITY, one("SELFIE")];
}

/** The requirement keys, as a plain list — kept for callers that only need "what we ask for". */
export const KYC_REQUIRED_DOCUMENTS: Record<CustomerTypeValue, readonly KycDocumentTypeValue[]> = {
  INDIVIDUAL: kycRequirements("INDIVIDUAL").map((r) => r.key),
  BUSINESS: kycRequirements("BUSINESS").map((r) => r.key),
};

/** Every type staff or a customer may upload for this customer type, required first, optional after. */
export function kycUploadableDocuments(customerType: CustomerTypeValue): readonly KycDocumentTypeValue[] {
  const required = KYC_REQUIRED_DOCUMENTS[customerType];
  return customerType === "BUSINESS" ? [...required, "PASSPORT", "PPH_SUPPORT"] : [...required, "PASSPORT"];
}

/** The requirement a document type satisfies for this customer type, if any. */
export function kycRequirementFor(customerType: CustomerTypeValue, documentType: string): KycRequirement | undefined {
  return kycRequirements(customerType).find((r) => (r.anyOf as readonly string[]).includes(documentType));
}

/**
 * Which of `asked` (document types; default: everything required) are not
 * covered by `present` — the document types the customer has on file that
 * were not rejected. Returns the keys we would ask for, in checklist order.
 */
export function missingKycDocuments(
  customerType: CustomerTypeValue,
  present: Iterable<string>,
  asked?: readonly string[],
): KycDocumentTypeValue[] {
  const have = new Set(present);
  const out: KycDocumentTypeValue[] = [];
  for (const r of kycRequirements(customerType)) {
    if (asked && !asked.some((t) => (r.anyOf as readonly string[]).includes(t))) continue;
    if (!r.anyOf.some((t) => have.has(t))) out.push(r.key);
  }
  // Something asked for that is not a requirement (an optional PPh slip, say).
  for (const t of asked ?? []) {
    const parsed = KycDocumentTypeSchema.safeParse(t);
    if (!parsed.success || kycRequirementFor(customerType, t)) continue;
    if (!have.has(t) && !out.includes(parsed.data)) out.push(parsed.data);
  }
  return out;
}

export const KYC_DOCUMENT_LABELS: Readonly<Record<KycDocumentTypeValue, { id: string; en: string }>> = {
  KTP: { id: "KTP", en: "KTP (ID card)" },
  PASSPORT: { id: "Paspor", en: "Passport" },
  SELFIE: { id: "Selfie", en: "Selfie" },
  NIB: { id: "NIB", en: "NIB (business registration)" },
  NPWP: { id: "NPWP", en: "NPWP (tax registration)" },
  PPH_SUPPORT: { id: "Dokumen pendukung PPh", en: "PPh supporting document" },
};

/** "KTP (atau paspor), Selfie dan NPWP" — for a message that asks for documents. */
export function kycDocumentListText(types: readonly string[], lang: "id" | "en"): string {
  const names = types.map((t) => {
    const parsed = KycDocumentTypeSchema.safeParse(t);
    if (!parsed.success) return t;
    // A KTP can always be answered with a passport; say so where we ask for it.
    if (parsed.data === "KTP") return lang === "id" ? "KTP (atau paspor)" : "KTP (or passport)";
    return KYC_DOCUMENT_LABELS[parsed.data][lang];
  });
  if (names.length <= 1) return names[0] ?? "";
  const and = lang === "id" ? "dan" : "and";
  return `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;
}

/** Only these are sent to an automated identity check; the rest are read by a human. */
export const AUTO_VERIFIABLE_DOCUMENTS: readonly KycDocumentTypeValue[] = ["KTP", "SELFIE"];

/**
 * v1 upload is a single proxied multipart POST (not a presigned-URL
 * direct-to-storage flow) — the API receives the file via multer, then
 * calls StorageProvider.save() server-side. Simpler to get right at this
 * scale than a presigned-URL/token dance, and the raw bytes only ever
 * transit our own API over TLS, never a second hop the client controls.
 * See apps/api/src/kyc/kyc.controller.ts.
 */
export const KycVerificationSourceSchema = z.enum(["MANUAL", "AUTO"]);

export const KycDocumentDtoSchema = z.object({
  id: z.string().uuid(),
  documentType: KycDocumentTypeSchema,
  status: KycStatusSchema,
  createdAt: z.string().datetime(),
  reviewedAt: z.string().datetime().nullable(),
  /** AUTO means KycVerificationProvider decided this without a human in the loop (Session 21) — see apps/api/src/kyc/kyc-verification-provider.interface.ts. */
  verificationSource: KycVerificationSourceSchema,
  providerRef: z.string().nullable(),
  /** Provider's stated reason — populated for AUTO-REJECTED docs and for an inconclusive auto-check that fell back to the manual queue. */
  providerReason: z.string().nullable(),
  /** PRD go-live 2 §5.1 — who put the file in: the customer on the portal, or staff for a walk-in. */
  channel: z.enum(["CUSTOMER", "STAFF"]).optional(),
  uploadedByUserId: z.string().uuid().nullable().optional(),
  /** PRD go-live 2 §5.2 — the request (batch) this upload answers. */
  kycRequestId: z.string().uuid().nullable().optional(),
});
export type KycDocumentDto = z.infer<typeof KycDocumentDtoSchema>;

export const ReviewKycDocumentRequestSchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
  reason: z.string().optional(),
});
export type ReviewKycDocumentRequest = z.infer<typeof ReviewKycDocumentRequestSchema>;

/**
 * PRD go-live 2 §5.2 — a KYC request is one batch: what was asked of a
 * customer, when, by whom, and what came back.
 *
 * OPEN      asked; something is still missing
 * COMPLETE  everything asked has arrived; waiting for a reviewer
 * VERIFIED  a reviewer verified the batch
 * REJECTED  a reviewer rejected it, with a reason that was sent to the customer
 */
export const KycRequestStatusSchema = z.enum(["OPEN", "COMPLETE", "VERIFIED", "REJECTED"]);
export type KycRequestStatusValue = z.infer<typeof KycRequestStatusSchema>;

/**
 * How the request came about: staff asked by message (WHATSAPP), staff took
 * the files at the counter (STAFF), the customer started on the portal
 * (PORTAL), or the migration created it for documents that predate requests
 * (BACKFILL).
 */
export const KycRequestChannelSchema = z.enum(["WHATSAPP", "STAFF", "PORTAL", "BACKFILL"]);

export const KycRequestDocumentSchema = z.object({
  id: z.string().uuid(),
  documentType: z.string(),
  status: KycStatusSchema,
  channel: z.string(),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  /** False for a file that a newer upload of the same type replaced. */
  latest: z.boolean(),
  providerReason: z.string().nullable(),
});
export type KycRequestDocument = z.infer<typeof KycRequestDocumentSchema>;

export const KycRequestDtoSchema = z.object({
  id: z.string().uuid(),
  status: KycRequestStatusSchema,
  channel: z.string(),
  requestedTypes: z.array(z.string()),
  requestedAt: z.string(),
  requestedByName: z.string().nullable(),
  completedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decidedByName: z.string().nullable(),
  decisionReason: z.string().nullable(),
  /** Requirement keys still not on file. */
  missing: z.array(z.string()),
  documents: z.array(KycRequestDocumentSchema),
  customer: z.object({
    id: z.string().uuid(),
    customerNumber: z.number().nullable(),
    fullName: z.string().nullable(),
    phone: z.string().nullable(),
    type: CustomerTypeSchema,
    companyName: z.string().nullable(),
    pphWithheld: z.boolean().nullable(),
    kycStatus: KycStatusSchema,
  }),
  booking: z
    .object({ id: z.string().uuid(), status: z.string(), startDate: z.string(), unitCode: z.string().nullable(), unitTypeName: z.string().nullable() })
    .nullable(),
});
export type KycRequestDto = z.infer<typeof KycRequestDtoSchema>;

/** Verify the batch, or reject it — a rejection must say why, because the reason is sent to the customer. */
export const DecideKycRequestSchema = z
  .object({
    decision: z.enum(["VERIFIED", "REJECTED"]),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.decision !== "REJECTED" || (v.reason ?? "").length >= 3, {
    message: "Alasan penolakan wajib diisi — alasan ini dikirim ke pelanggan. / A rejection needs a reason; it is sent to the customer.",
    path: ["reason"],
  });
export type DecideKycRequest = z.infer<typeof DecideKycRequestSchema>;

/** What the staff KYC panel (client page, booking page) shows for one customer. */
export const CustomerKycSummarySchema = z.object({
  customerId: z.string().uuid(),
  customerType: CustomerTypeSchema,
  kycStatus: KycStatusSchema,
  required: z.array(z.string()),
  uploadable: z.array(z.string()),
  missing: z.array(z.string()),
  documents: z.array(KycRequestDocumentSchema),
  openRequest: z
    .object({ id: z.string().uuid(), status: KycRequestStatusSchema, requestedTypes: z.array(z.string()), requestedAt: z.string(), channel: z.string() })
    .nullable(),
});
export type CustomerKycSummary = z.infer<typeof CustomerKycSummarySchema>;

/**
 * The customer's own answer to "Apakah dibebankan PPh?", set from the portal.
 * Separate from the document upload because the answer is the thing invoicing
 * needs; the supporting file is optional evidence for staff.
 */
export const UpdateTaxProfileRequestSchema = z.object({
  pphWithheld: z.boolean(),
  /** NPWP number, typed rather than read off the uploaded document. */
  taxId: z.string().max(40).optional(),
  /** NIB number, same. */
  nib: z.string().max(40).optional(),
});
export type UpdateTaxProfileRequest = z.infer<typeof UpdateTaxProfileRequestSchema>;

/** PRD go-live §8.2 — staff correct a client's tax answers from the client page. */
export const PphTypeSchema = z.enum(["PPH_4_2_FINAL", "PPH_23"]);
export const StaffTaxProfileRequestSchema = z.object({
  pphWithheld: z.boolean().nullable().optional(),
  pphType: PphTypeSchema.nullable().optional(),
  taxId: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
});
export type StaffTaxProfileRequest = z.infer<typeof StaffTaxProfileRequestSchema>;
