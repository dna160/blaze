import { getPrismaClient, parseIcalEvents, withTenantContext } from "@rentos/database";

/**
 * "OTA channel sync" (PRD §13 Phase 4, Session 22) — pulls each active
 * OtaCalendarSubscription's external .ics feed and turns its VEVENTs
 * into OtaBlockedDate rows, so a guest booked directly through Airbnb/
 * Booking.com doesn't get double-booked through RentOS
 * (BookingService.createBooking's non-pooled NIGHTLY path excludes
 * blocked assets — see packages/database/src/ota-blocking.ts). Runs
 * hourly (see queues.ts), same tenants-loop shape as
 * generate-recurring-invoices.job.ts, gated per tenant by
 * featureFlags.ota_sync_enabled.
 *
 * Each sync is a full replace for that subscription: any previously
 * synced date range whose UID no longer appears in the feed is deleted
 * (a cancelled Airbnb reservation should stop blocking those nights),
 * and every UID still present is upserted with its latest date range.
 */
export async function runSyncOtaCalendars(): Promise<void> {
  const prisma = getPrismaClient();
  const tenants = await prisma.tenant.findMany();

  for (const tenant of tenants) {
    const featureFlags = (tenant.featureFlags ?? {}) as Record<string, unknown>;
    if (!featureFlags.ota_sync_enabled) continue;

    await withTenantContext(prisma, tenant.id, async (tx) => {
      const subscriptions = await tx.otaCalendarSubscription.findMany({ where: { isActive: true } });

      for (const subscription of subscriptions) {
        try {
          const response = await fetch(subscription.sourceUrl, { signal: AbortSignal.timeout(15_000) });
          if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status}`);
          const events = parseIcalEvents(await response.text());

          const currentUids = events.map((e) => e.uid);
          await tx.otaBlockedDate.deleteMany({
            where: { subscriptionId: subscription.id, externalUid: { notIn: currentUids } },
          });
          for (const event of events) {
            await tx.otaBlockedDate.upsert({
              where: { subscriptionId_externalUid: { subscriptionId: subscription.id, externalUid: event.uid } },
              update: { startDate: event.startDate, endDate: event.endDate },
              create: {
                tenantId: tenant.id,
                assetId: subscription.assetId,
                subscriptionId: subscription.id,
                externalUid: event.uid,
                startDate: event.startDate,
                endDate: event.endDate,
              },
            });
          }

          await tx.otaCalendarSubscription.update({
            where: { id: subscription.id },
            data: { lastSyncedAt: new Date(), lastSyncStatus: "SUCCEEDED", lastSyncError: null },
          });
        } catch (err) {
          await tx.otaCalendarSubscription.update({
            where: { id: subscription.id },
            data: { lastSyncedAt: new Date(), lastSyncStatus: "FAILED", lastSyncError: (err as Error).message },
          });
        }
      }
    });
  }
}
