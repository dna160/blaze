import { z } from "zod";

/**
 * The legacy archive (owner, 2026-11-12): records of the previous system kept
 * as it made them. Imported in batches by an org-scoped Admin; read by staff.
 */
export const LEGACY_KINDS = ["CUSTOMER", "ORDER", "INVOICE", "CONTRACT", "QUOTE", "PAYMENT", "NOTE", "EMAIL", "TEXT", "CONFIG"] as const;
export const LegacyKindSchema = z.enum(LEGACY_KINDS);
export type LegacyKind = z.infer<typeof LegacyKindSchema>;

export const LegacyRecordInputSchema = z.object({
  kind: LegacyKindSchema,
  legacyId: z.string().min(1).max(200),
  number: z.string().max(120).nullable().optional(),
  customerNumber: z.number().int().positive().nullable().optional(),
  customerName: z.string().max(300).nullable().optional(),
  occurredAt: z.string().max(40).nullable().optional(),
  amount: z.number().nullable().optional(),
  status: z.string().max(80).nullable().optional(),
  title: z.string().max(2000).nullable().optional(),
  data: z.record(z.unknown()),
});

export const LegacyImportRequestSchema = z.object({
  source: z.string().regex(/^[a-z0-9_-]{2,40}$/),
  records: z.array(LegacyRecordInputSchema).min(1).max(2000),
});
export type LegacyImportRequest = z.infer<typeof LegacyImportRequestSchema>;

export const LegacyListQuerySchema = z.object({
  kind: LegacyKindSchema.optional(),
  customerNumber: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export interface LegacyRecordListItem {
  id: string;
  source: string;
  kind: LegacyKind;
  number: string | null;
  customerId: string | null;
  customerNumber: number | null;
  customerName: string | null;
  occurredAt: string | null;
  amount: string | null;
  status: string | null;
  title: string | null;
}

export interface LegacyRecordDetail extends LegacyRecordListItem {
  data: Record<string, unknown>;
  bodyHtml: string | null;
  footerHtml: string | null;
}
