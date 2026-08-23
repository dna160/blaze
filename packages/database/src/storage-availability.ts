import { isUnitFreeFor, termEndDate, type CommittedBookingLike } from "@rentos/domain";

import type { Prisma } from "../generated/client/index.js";

/**
 * Date-range availability for RECURRING_LEASE units (PRD v2 §4.3, P8).
 *
 * Before v2, storage availability was a point-in-time count of
 * `Asset.status = AVAILABLE` — fine for "can I move in today", wrong for
 * "can I move in on 1 October" (a unit occupied until 1 September is
 * bookable then) and wrong for the blackout month (a unit freed on 1
 * September must NOT be bookable until 1 October). Since v2,
 * `Asset.status` is the physical/floor state; whether a unit can be
 * booked for a window is answered here, by comparing the candidate's hold
 * window against every committed booking on the unit — the overlap rule
 * itself is `@rentos/domain`'s `isUnitFreeFor`, unit-tested there.
 *
 * Committed = holds the unit for its window. WAITLISTED never holds
 * anything; requests that died before activation (REJECTED/EXPIRED/
 * LAPSED) free it immediately. Leases that ENDED (MOVED_OUT/CLOSED) still
 * hold their window — the blackout month runs from the end date, so a
 * unit vacated on 1 Sep stays unbookable to others until 1 Oct even
 * though the booking itself is over (PRD v2 D2). A legacy indefinite
 * lease that ended has no endDate; its notice date / last update stands
 * in so it can't hold the unit forever.
 */
export const UNIT_HOLDING_STATUSES = [
  "PENDING_APPROVAL",
  "NEEDS_INFO",
  "APPROVED",
  "ACTIVE",
  "RENEWING",
  "SUSPENDED",
  "NOTICE_GIVEN",
  "DEFAULT",
  "MOVED_OUT",
  "CLOSED",
] as const;

const ENDED_STATUSES = new Set(["MOVED_OUT", "CLOSED"]);

export interface StorageWindow {
  startDate: Date;
  termMonths: number;
}

export interface StorageAvailabilityOptions {
  blackoutMonths: number;
  customerId?: string;
  extendsBookingId?: string;
}

interface CandidateAsset {
  id: string;
  code: string;
  bookings: CommittedBookingLike[];
}

async function loadCandidates(
  tx: Prisma.TransactionClient,
  assetTypeId: string,
  locationId: string | undefined,
): Promise<CandidateAsset[]> {
  const assets = await tx.asset.findMany({
    where: {
      assetTypeId,
      locationId,
      status: { notIn: ["MAINTENANCE", "RETIRED"] },
    },
    select: {
      id: true,
      code: true,
      bookings: {
        where: { status: { in: [...UNIT_HOLDING_STATUSES] } },
        select: { id: true, customerId: true, status: true, startDate: true, endDate: true, noticeEffectiveDate: true, updatedAt: true },
      },
    },
    orderBy: { code: "asc" },
  });
  return assets.map((a) => ({
    id: a.id,
    code: a.code,
    bookings: a.bookings.map((b) => ({
      id: b.id,
      customerId: b.customerId,
      startDate: b.startDate,
      // An early-terminated term ends on its notice date, not its original end date.
      endDate: b.noticeEffectiveDate && (!b.endDate || b.noticeEffectiveDate < b.endDate) ? b.noticeEffectiveDate : (b.endDate ?? (ENDED_STATUSES.has(b.status) ? b.updatedAt : null)),
    })),
  }));
}

/** Every unit of the type at the location that is free for the window, lowest code first. */
export async function listAvailableStorageAssets(
  tx: Prisma.TransactionClient,
  assetTypeId: string,
  locationId: string | undefined,
  window: StorageWindow,
  options: StorageAvailabilityOptions,
): Promise<Array<{ id: string; code: string }>> {
  const candidate = { startDate: window.startDate, endDate: termEndDate(window.startDate, window.termMonths) };
  const candidates = await loadCandidates(tx, assetTypeId, locationId);
  return candidates
    .filter((asset) =>
      isUnitFreeFor(candidate, asset.bookings, {
        blackoutMonths: options.blackoutMonths,
        customerId: options.customerId,
        extendsBookingId: options.extendsBookingId,
      }),
    )
    .map((a) => ({ id: a.id, code: a.code }));
}

export async function countAvailableStorageAssets(
  tx: Prisma.TransactionClient,
  assetTypeId: string,
  locationId: string | undefined,
  window: StorageWindow,
  options: StorageAvailabilityOptions,
): Promise<number> {
  return (await listAvailableStorageAssets(tx, assetTypeId, locationId, window, options)).length;
}

/**
 * The unit a new booking should soft-reserve: lowest code that is free for
 * the window. When the booking is an extension, the parent's own unit is
 * preferred (it's exempt from its own blackout), falling back to any free
 * unit of the type so a customer who can't keep their exact unit can still
 * stay with the branch.
 */
export async function findAvailableStorageAsset(
  tx: Prisma.TransactionClient,
  assetTypeId: string,
  locationId: string | undefined,
  window: StorageWindow,
  options: StorageAvailabilityOptions & { preferredAssetId?: string },
): Promise<string | null> {
  // Single-fire lock (BUILD-SPEC C5 rule 2). Availability is read-then-write:
  // without a lock, two concurrent submissions for the last free unit both see
  // it free and both take it — a double booking with a signed contract
  // attached. Locking every candidate row of the type/branch FIRST serialises
  // those transactions, so the second one re-reads the queue after the first
  // has committed its booking and correctly finds the unit taken.
  //
  // ORDER BY id keeps the lock order identical across callers, so two
  // transactions locking overlapping candidate sets can't deadlock. This runs
  // inside runInTenantContext, so RLS still scopes the rows.
  await tx.$queryRaw`
    SELECT id FROM assets
    WHERE asset_type_id = ${assetTypeId}::uuid
      AND (${locationId ?? null}::uuid IS NULL OR location_id = ${locationId ?? null}::uuid)
      AND status NOT IN ('MAINTENANCE', 'RETIRED')
    ORDER BY id
    FOR UPDATE
  `;

  const free = await listAvailableStorageAssets(tx, assetTypeId, locationId, window, options);
  if (options.preferredAssetId && free.some((a) => a.id === options.preferredAssetId)) return options.preferredAssetId;
  return free[0]?.id ?? null;
}

/** Tenant-configurable blackout (PRD v2 D2): `featureFlags.blackout_months`, default 1, 0 disables. */
export function resolveBlackoutMonths(featureFlags: unknown): number {
  const flags = (featureFlags ?? {}) as Record<string, unknown>;
  const raw = flags.blackout_months;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  return 1;
}

/** Tenant-configurable issue lead time for scheduled cycle invoices (PRD §8.2): `featureFlags.invoice_lead_days`, default 7. */
export function resolveInvoiceLeadDays(featureFlags: unknown): number {
  const flags = (featureFlags ?? {}) as Record<string, unknown>;
  const raw = flags.invoice_lead_days;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  return 7;
}
