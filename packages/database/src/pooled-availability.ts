import type { Prisma } from "../generated/client/index.js";

/**
 * Booking statuses that hold a claim on pooled capacity — anything
 * between submission and the unit physically coming back (or the
 * request dying without ever occupying a unit). Deliberately excludes
 * terminal/dead-end statuses (REJECTED, EXPIRED, CLOSED, NO_SHOW) so a
 * rejected or completed booking frees its slot immediately. Only
 * NIGHTLY and DURATION_ORDER are listed — both always carry an endDate,
 * which a date-range overlap query needs; pooled RECURRING_LEASE (an
 * indefinite lease with no window to overlap against) isn't supported.
 */
const POOLED_COMMITTED_STATUSES: Record<string, string[]> = {
  NIGHTLY: ["PENDING_APPROVAL", "NEEDS_INFO", "APPROVED", "PAID", "CHECKED_IN"],
  DURATION_ORDER: ["PENDING_APPROVAL", "APPROVED", "PAID", "PICKED_UP", "RETURNED", "INSPECTION"],
};

export interface PooledAssetType {
  id: string;
  bookingModel: string;
}

/**
 * Capacity-based availability for a pooled AssetType (`isPooled: true`)
 * over a date window — see AssetType.isPooled's doc comment and
 * docs/HANDOFF.md Session 17. Counts in-service units (excludes RETIRED
 * and MAINTENANCE) minus bookings already committed to an overlapping
 * window, rather than checking any single Asset's live status: the
 * whole point of a pool is that no specific unit is held for a booking
 * until it's approved, so two bookings for non-overlapping date ranges
 * can be satisfied by the same physical inventory. Overlap is the
 * standard half-open-interval test: `existing.startDate < windowEnd &&
 * existing.endDate > windowStart`.
 */
export async function computePooledAvailableCount(
  tx: Prisma.TransactionClient,
  assetType: PooledAssetType,
  windowStart: Date,
  windowEnd: Date,
): Promise<number> {
  const committedStatuses = POOLED_COMMITTED_STATUSES[assetType.bookingModel];
  if (!committedStatuses) {
    throw new Error(`Pooled inventory is not supported for ${assetType.bookingModel} bookings.`);
  }
  const [inService, committed] = await Promise.all([
    tx.asset.count({ where: { assetTypeId: assetType.id, status: { notIn: ["RETIRED", "MAINTENANCE"] } } }),
    tx.booking.count({
      where: {
        assetTypeId: assetType.id,
        status: { in: committedStatuses as never },
        startDate: { lt: windowEnd },
        endDate: { gt: windowStart },
      },
    }),
  ]);
  return Math.max(0, inService - committed);
}

/**
 * Picks a concrete Asset out of the pool for a booking that's being
 * approved without one — the lowest-code in-service unit not already
 * committed to another booking overlapping this window. Returns null
 * when the pool is exhausted for the requested dates (a real "sold out"
 * outcome, not an error — the caller decides how to surface it).
 */
export async function findAvailablePooledAsset(
  tx: Prisma.TransactionClient,
  assetType: PooledAssetType,
  windowStart: Date,
  windowEnd: Date,
): Promise<string | null> {
  const committedStatuses = POOLED_COMMITTED_STATUSES[assetType.bookingModel];
  if (!committedStatuses) return null;

  const overlapping = await tx.booking.findMany({
    where: {
      assetTypeId: assetType.id,
      status: { in: committedStatuses as never },
      startDate: { lt: windowEnd },
      endDate: { gt: windowStart },
      assetId: { not: null },
    },
    select: { assetId: true },
  });
  const committedAssetIds = overlapping.map((b) => b.assetId).filter((id): id is string => id !== null);

  const asset = await tx.asset.findFirst({
    where: {
      assetTypeId: assetType.id,
      status: { notIn: ["RETIRED", "MAINTENANCE"] },
      id: { notIn: committedAssetIds },
    },
    orderBy: { code: "asc" },
  });
  return asset?.id ?? null;
}
