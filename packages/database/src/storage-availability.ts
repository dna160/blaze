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
 * Committed = holds the unit. WAITLISTED never holds anything; terminal
 * states (REJECTED/EXPIRED/LAPSED/MOVED_OUT/CLOSED) free it immediately.
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
] as const;

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
        select: { id: true, customerId: true, startDate: true, endDate: true },
      },
    },
    orderBy: { code: "asc" },
  });
  return assets.map((a) => ({
    id: a.id,
    code: a.code,
    bookings: a.bookings.map((b) => ({ id: b.id, customerId: b.customerId, startDate: b.startDate, endDate: b.endDate })),
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
