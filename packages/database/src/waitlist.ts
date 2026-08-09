import { computeFireExpiry, monthlyPeriodEnd, nextArmedEntry } from "@rentos/domain";

import type { Prisma } from "../generated/client/index.js";
import { generateRentalOrderInvoice } from "./invoicing.js";

/**
 * BUILD-SPEC C5 — fire the next armed waitlist entry for a released unit, as a
 * single shared code path used by BOTH the API WaitlistService and the worker
 * jobs (waitlist-expiry, renewal-timeout) so the single-fire logic never drifts
 * into three divergent copies.
 *
 * MUST be called inside a tenant-context transaction (withTenantContext /
 * runInTenantContext). Takes a row lock on the asset (SELECT ... FOR UPDATE)
 * before reading the queue, so concurrent callers serialize and only ONE creates
 * a contract + invoice for the unit. Returns the fired order id, or null.
 */
export async function fireNextWaitlistEntry(
  tx: Prisma.TransactionClient,
  params: { tenantId: string; tenantSlug: string; isPkp: boolean; assetId: string; ttlHours: number },
): Promise<{ orderId: string; invoiceId: string; waitlistEntryId: string } | null> {
  const { tenantId, tenantSlug, isPkp, assetId, ttlHours } = params;

  // Row lock — the single-fire guard, held until this transaction commits.
  await tx.$queryRaw`SELECT id FROM assets WHERE id = ${assetId}::uuid FOR UPDATE`;

  const asset = await tx.asset.findUnique({ where: { id: assetId } });
  if (!asset || asset.status !== "AVAILABLE") return null; // already claimed by a concurrent fire

  const armed = await tx.waitlistEntry.findMany({
    where: { assetTypeId: asset.assetTypeId, status: "ARMED" },
    orderBy: { position: "asc" },
  });
  const next = nextArmedEntry(armed.map((e) => ({ id: e.id, position: e.position, status: e.status })));
  if (!next) return null;
  const entry = armed.find((e) => e.id === next.id)!;

  const periodStart = new Date();
  const periodEnd = monthlyPeriodEnd(periodStart, 1); // C3 — whole month
  const order = await tx.rentalOrder.create({
    data: {
      tenantId,
      customerId: entry.customerId,
      assetTypeId: asset.assetTypeId,
      assetId: asset.id,
      status: "AWAITING_PAYMENT",
      periodStart,
      periodEnd,
      priceSnapshot: entry.priceSnapshot as object,
    },
  });

  await tx.contract.create({
    data: {
      tenantId,
      rentalOrderId: order.id,
      templateVersion: "v1",
      esignProvider: "MOCK",
      esignStatus: "SIGNED",
      signedAt: new Date(),
    },
  });
  const invoice = await generateRentalOrderInvoice(
    tx,
    tenantId,
    tenantSlug,
    isPkp,
    { id: order.id, customerId: order.customerId, periodStart, periodEnd, priceSnapshot: order.priceSnapshot },
    { includeDeposit: true },
  );

  await tx.asset.update({ where: { id: asset.id }, data: { status: "RESERVED" } });
  const firedAt = new Date();
  await tx.waitlistEntry.update({
    where: { id: entry.id },
    data: { status: "FIRED", firedAt, expiresAt: computeFireExpiry(firedAt, ttlHours), firedRentalOrderId: order.id },
  });
  await tx.rentalOrderEvent.create({
    data: {
      tenantId,
      rentalOrderId: order.id,
      toStatus: "AWAITING_PAYMENT",
      actorType: "SYSTEM",
      reason: "Waitlist fired on unit release",
      metadata: { waitlistEntryId: entry.id, invoiceId: invoice.id },
    },
  });

  return { orderId: order.id, invoiceId: invoice.id, waitlistEntryId: entry.id };
}
