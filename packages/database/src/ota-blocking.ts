import type { Prisma } from "../generated/client/index.js";

/**
 * Non-pooled asset selection (`BookingService.createBooking`) picks the
 * lowest-code `AVAILABLE` unit with no date-range check at all today —
 * a pre-existing, single-current-booking-per-asset simplification (see
 * docs/HANDOFF.md). This is the OTA-aware version: it additionally
 * excludes any Asset with an `OtaBlockedDate` row overlapping the
 * requested window (half-open interval test, same as
 * `computePooledAvailableCount`'s), so a night already reserved through
 * Airbnb/Booking.com can't also be double-booked through RentOS. Only
 * meaningful for NIGHTLY, the one booking model OTA sync targets — pass
 * null windowStart/windowEnd for any other model to skip the check
 * entirely (no `OtaBlockedDate` rows exist for other AssetTypes anyway).
 */
export async function findAvailableNonPooledAsset(
  tx: Prisma.TransactionClient,
  assetTypeId: string,
  windowStart: Date | null,
  windowEnd: Date | null,
): Promise<string | null> {
  const blockedAssetIds =
    windowStart && windowEnd
      ? (
          await tx.otaBlockedDate.findMany({
            where: { asset: { assetTypeId }, startDate: { lt: windowEnd }, endDate: { gt: windowStart } },
            select: { assetId: true },
          })
        ).map((b) => b.assetId)
      : [];

  const asset = await tx.asset.findFirst({
    where: { assetTypeId, status: "AVAILABLE", id: { notIn: blockedAssetIds } },
    orderBy: { code: "asc" },
  });
  return asset?.id ?? null;
}
