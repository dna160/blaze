import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { generateIcalFeed } from "@rentos/database";

import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

const LIST_SELECT = {
  id: true,
  assetId: true,
  label: true,
  sourceUrl: true,
  isActive: true,
  lastSyncedAt: true,
  lastSyncStatus: true,
  lastSyncError: true,
  createdAt: true,
} as const;

/**
 * Bookings that hold a real night on the calendar — same list as
 * pooled-availability.ts's NIGHTLY entry (kept separate rather than
 * imported since that constant is keyed by booking model for a
 * different purpose; this is the export feed's own single-model need).
 */
const NIGHTLY_COMMITTED_STATUSES = ["PENDING_APPROVAL", "NEEDS_INFO", "APPROVED", "PAID", "CHECKED_IN"];

/**
 * Outbound iCal export (a tenant pastes the feed URL into Airbnb/
 * Booking.com's "import calendar" field) + inbound subscription CRUD
 * (apps/worker's sync-ota-calendars job does the actual fetching/
 * parsing on a schedule — this service only registers what to sync).
 * Gated per tenant by featureFlags.ota_sync_enabled (PRD §13 "OTA
 * channel sync", Session 22). See docs/HANDOFF.md for why this only
 * targets NIGHTLY, non-pooled Assets.
 */
@Injectable()
export class OtaSyncService {
  constructor(private readonly prisma: PrismaService) {}

  async generateFeed(tenant: ResolvedTenant, assetId: string): Promise<string> {
    this.assertEnabled(tenant);
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const asset = await tx.asset.findUnique({ where: { id: assetId }, include: { assetType: true } });
      if (!asset) throw new NotFoundException("Asset not found.");

      const bookings = await tx.booking.findMany({
        where: {
          assetId,
          status: { in: NIGHTLY_COMMITTED_STATUSES as never },
          endDate: { not: null },
        },
      });

      return generateIcalFeed(
        `${tenant.name} — ${asset.code}`,
        bookings.map((b) => ({ uid: `rentos-booking-${b.id}`, startDate: b.startDate, endDate: b.endDate! })),
      );
    });
  }

  async createSubscription(tenant: ResolvedTenant, createdByUserId: string, assetId: string, label: string, sourceUrl: string) {
    this.assertEnabled(tenant);
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const asset = await tx.asset.findUnique({ where: { id: assetId } });
      if (!asset) throw new NotFoundException("Asset not found.");
      return tx.otaCalendarSubscription.create({
        data: { tenantId: tenant.id, assetId, label, sourceUrl, createdByUserId },
        select: LIST_SELECT,
      });
    });
  }

  list(tenant: ResolvedTenant) {
    this.assertEnabled(tenant);
    return this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.otaCalendarSubscription.findMany({ select: LIST_SELECT, orderBy: { createdAt: "desc" } }),
    );
  }

  async remove(tenant: ResolvedTenant, id: string) {
    this.assertEnabled(tenant);
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const existing = await tx.otaCalendarSubscription.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException("Subscription not found.");
      await tx.otaCalendarSubscription.delete({ where: { id } });
      return { status: "deleted" };
    });
  }

  private assertEnabled(tenant: ResolvedTenant) {
    if (!tenant.featureFlags.ota_sync_enabled) {
      throw new ForbiddenException("OTA calendar sync is not enabled for this tenant.");
    }
  }
}
