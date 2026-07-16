import type { Prisma } from "../generated/client/index.js";

/**
 * Tenant-prefixed, sequential, tax-compliant invoice numbers (PRD §7.2.4).
 * v1 derives the sequence from a per-tenant monthly count inside the same
 * transaction as invoice creation — correct at demo scale, but count-based
 * sequencing races under concurrent invoice creation for the same tenant.
 * A dedicated Postgres sequence per tenant is the Phase 2 fix; tracked in
 * docs/HANDOFF.md.
 */
export async function nextInvoiceNumber(tx: Prisma.TransactionClient, tenantId: string, tenantSlug: string) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const count = await tx.invoice.count({
    where: { tenantId, createdAt: { gte: new Date(year, now.getMonth(), 1) } },
  });
  const sequence = String(count + 1).padStart(6, "0");
  return `${tenantSlug.toUpperCase()}/${year}/${month}/${sequence}`;
}
