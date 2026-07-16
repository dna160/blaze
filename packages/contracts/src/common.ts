import { z } from "zod";

/**
 * Money crosses the wire as a decimal string, never a JS number — floats
 * cannot round-trip Postgres NUMERIC(14,2) exactly, and money silently
 * losing precision in a rental-finance product is not an acceptable
 * failure mode. Parse into Decimal (see @rentos/domain) at the boundary.
 */
export const MoneyStringSchema = z.string().regex(/^-?\d+(\.\d{1,2})?$/, "expected a decimal amount string");

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export function paginatedResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  });
}

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
