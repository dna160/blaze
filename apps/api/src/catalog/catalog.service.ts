import { Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service.js";

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  listPublishedAssetTypes(tenantId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.assetType.findMany({ where: { isPublished: true }, orderBy: { createdAt: "asc" } }),
    );
  }

  async getAssetType(tenantId: string, assetTypeId: string) {
    const assetType = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.assetType.findUnique({ where: { id: assetTypeId } }),
    );
    if (!assetType) throw new NotFoundException("AssetType not found.");
    return assetType;
  }

  /** Availability = count of AVAILABLE assets for this AssetType (PRD §7.1.1). v1 has no date-range calendar yet — RECURRING_LEASE availability is a point-in-time count, not a range query. */
  async availableCount(tenantId: string, assetTypeId: string): Promise<number> {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.asset.count({ where: { assetTypeId, status: "AVAILABLE" } }),
    );
  }

  listAssets(tenantId: string, filters: { locationId?: string; assetTypeId?: string; status?: string }) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.asset.findMany({
        where: {
          locationId: filters.locationId,
          assetTypeId: filters.assetTypeId,
          status: filters.status as never,
        },
        orderBy: { code: "asc" },
      }),
    );
  }

  listLocations(tenantId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) => tx.location.findMany({ orderBy: { name: "asc" } }));
  }

  /**
   * Staff-only — includes occupant PII (customer name/phone), unlike
   * `listAssets` above which backs the unauthenticated storefront catalog.
   * Combines PRD §7.2.2's "visual unit map (grid/floor layout)" (P1) with
   * "occupancy view: who's in which unit, since when, paid-through date"
   * (P0) into one query: for each OCCUPIED asset, its current ACTIVE/
   * RENEWING/SUSPENDED booking (there's at most one, per the booking FSM)
   * gives move-in date, and that booking's most recently PAID invoice's
   * `periodEnd` gives paid-through date.
   */
  unitMap(tenantId: string, filters: { locationId?: string }) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.asset.findMany({
        where: { locationId: filters.locationId },
        include: {
          assetType: { select: { name: true } },
          location: { select: { id: true, name: true } },
          bookings: {
            where: { status: { in: ["ACTIVE", "RENEWING", "SUSPENDED"] } },
            orderBy: { createdAt: "desc" },
            take: 1,
            include: {
              customer: { select: { fullName: true, phone: true } },
              invoices: { where: { status: "PAID" }, orderBy: { periodEnd: "desc" }, take: 1, select: { periodEnd: true } },
            },
          },
        },
        orderBy: [{ locationId: "asc" }, { code: "asc" }],
      }),
    );
  }
}
