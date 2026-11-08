import { z } from "zod";

/**
 * PRD go-live §5.1 — the branch (Tenant) profile, edited in Console →
 * Settings → Branch by an organization-scoped Admin and printed on every
 * contract and invoice.
 */

export const BankAccountSchema = z.object({
  bank: z.string().trim().min(2).max(80),
  accountNumber: z.string().trim().min(4).max(40),
  accountName: z.string().trim().min(2).max(120),
  swift: z.string().trim().max(20).nullable().optional(),
  showOnInvoice: z.boolean(),
});
export type BankAccount = z.infer<typeof BankAccountSchema>;

export const BranchContactSchema = z.object({
  /** E.164, e.g. +628111877838 — what wa.me links use. */
  whatsapp: z.string().trim().max(30).nullable().optional(),
  /** How the number is printed, e.g. "+62 811-1877-838". */
  whatsappDisplay: z.string().trim().max(40).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(120).nullable().optional().or(z.literal("")),
  csDisplayName: z.string().trim().max(80).nullable().optional(),
});
export type BranchContact = z.infer<typeof BranchContactSchema>;

export const OperatingHoursSchema = z.object({
  days: z.string().trim().max(80).optional(),
  open: z.string().trim().max(10).optional(),
  close: z.string().trim().max(10).optional(),
  tz: z.string().trim().max(10).optional(),
});

export const NumberingSchema = z.object({
  contract: z.string().trim().min(3).max(80).optional(),
  invoice: z.string().trim().min(3).max(80).optional(),
  creditNote: z.string().trim().min(3).max(80).optional(),
  seqReset: z.enum(["never", "yearly", "monthly"]).optional(),
});

/** Public: what the storefront and portal may show anyone. */
export const BranchPublicProfileSchema = z.object({
  name: z.string(),
  legalName: z.string().nullable(),
  isPkp: z.boolean(),
  contact: BranchContactSchema,
  address: z.array(z.string()),
  operatingHours: OperatingHoursSchema,
  facilities: z.array(z.string()),
  /** Only accounts flagged showOnInvoice. */
  bankAccounts: z.array(BankAccountSchema),
  /** PRD go-live §4.3 — false means: hide Pay, show the bank transfer details. */
  onlinePaymentsEnabled: z.boolean(),
});
export type BranchPublicProfile = z.infer<typeof BranchPublicProfileSchema>;

/** Staff: the whole editable profile. */
export const BranchSettingsSchema = BranchPublicProfileSchema.extend({
  id: z.string(),
  slug: z.string(),
  branchCode: z.string().nullable(),
  timezone: z.string(),
  organizationLegalName: z.string().nullable(),
  bankAccounts: z.array(BankAccountSchema),
  numbering: NumberingSchema,
  /** The branch's own switch (featureFlags.onlinePaymentsEnabled). */
  onlinePaymentsFlag: z.boolean(),
  /** Whether this deployment has a real gateway at all (PAYMENT_PROVIDER=xendit in production). */
  gatewayReady: z.boolean(),
  /** A sample of the next numbers, so a format change can be checked before saving. */
  numberPreview: z.object({ contract: z.string(), invoice: z.string() }),
  canEdit: z.boolean(),
});
export type BranchSettings = z.infer<typeof BranchSettingsSchema>;

export const UpdateBranchSettingsRequestSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  legalName: z.string().trim().max(160).nullable().optional(),
  organizationLegalName: z.string().trim().max(160).nullable().optional(),
  branchCode: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{2,6}$/, "2–6 capital letters or digits, e.g. KBJ")
    .nullable()
    .optional(),
  isPkp: z.boolean().optional(),
  timezone: z.string().trim().min(3).max(64).optional(),
  contact: BranchContactSchema.optional(),
  address: z.array(z.string().trim().max(160)).max(6).optional(),
  operatingHours: OperatingHoursSchema.optional(),
  facilities: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  bankAccounts: z.array(BankAccountSchema).max(5).optional(),
  numbering: NumberingSchema.optional(),
  onlinePaymentsEnabled: z.boolean().optional(),
});
export type UpdateBranchSettingsRequest = z.infer<typeof UpdateBranchSettingsRequestSchema>;
