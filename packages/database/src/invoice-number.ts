import type { Prisma } from "../generated/client/index.js";

/**
 * Tenant-prefixed, sequential, tax-compliant invoice numbers (PRD §7.2.4).
 *
 * Session 24: sequencing is now an atomic upsert-and-increment against a
 * dedicated per-tenant-per-month counter row (`InvoiceNumberCounter`),
 * not a `COUNT(*)` snapshot. The `INSERT ... ON CONFLICT ... DO UPDATE
 * ... RETURNING` runs as a single statement, so Postgres's own row-level
 * lock on the conflicting `(tenant_id, year, month)` key serializes
 * concurrent callers for the same tenant/month — two invoices "created
 * simultaneously" can never read-then-write the same sequence number the
 * way the original `COUNT(*)`-based version could (caught, but only as
 * a hard failure, by `Invoice`'s own `[tenantId, invoiceNumber]` unique
 * constraint). See docs/HANDOFF.md Session 24 for the migration's
 * backfill, which seeded each tenant/month's starting counter from the
 * invoice count already on record so this switch didn't collide with
 * already-issued numbers.
 */
export async function nextInvoiceNumber(tx: Prisma.TransactionClient, tenantId: string, tenantSlug: string) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const rows = await tx.$queryRaw<{ counter: number }[]>`
    INSERT INTO invoice_number_counters (id, tenant_id, year, month, counter)
    VALUES (gen_random_uuid(), ${tenantId}::uuid, ${year}, ${month}, 1)
    ON CONFLICT (tenant_id, year, month)
    DO UPDATE SET counter = invoice_number_counters.counter + 1
    RETURNING counter
  `;

  const sequence = String(rows[0]!.counter).padStart(6, "0");
  return `${tenantSlug.toUpperCase()}/${year}/${String(month).padStart(2, "0")}/${sequence}`;
}
