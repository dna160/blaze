import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { computePooledAvailableCount, type Prisma } from "@rentos/database";
import type { CreateAssetRequest, CreateAssetTypeRequest, UpdateAssetTypeRequest } from "@rentos/contracts";

import { PrismaService } from "../prisma/prisma.service.js";

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  listPublishedAssetTypes(tenantId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.assetType.findMany({ where: { isPublished: true }, orderBy: { createdAt: "asc" } }),
    );
  }

  /** Staff-only — includes unpublished/draft AssetTypes, unlike the public list above. Backs the catalog setup console page. */
  listAllAssetTypes(tenantId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) => tx.assetType.findMany({ orderBy: { createdAt: "asc" } }));
  }

  async getAssetType(tenantId: string, assetTypeId: string) {
    const assetType = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.assetType.findUnique({ where: { id: assetTypeId } }),
    );
    if (!assetType) throw new NotFoundException("AssetType not found.");
    return assetType;
  }

  /**
   * Non-pooled: count of AVAILABLE assets for this AssetType (PRD
   * §7.1.1) — v1 has no date-range calendar for these; RECURRING_LEASE
   * availability is a point-in-time count, not a range query.
   *
   * Pooled (`AssetType.isPooled`): a real capacity-over-a-window count
   * via `computePooledAvailableCount` (`@rentos/database`, Session 17).
   * `window` defaults to "right now" (a zero-length window) when the
   * caller has no specific dates yet — e.g. the storefront asset-type
   * page, shown before a customer picks dates. The number that actually
   * gates a booking is recomputed against the customer's real requested
   * dates at submission time (`BookingService.createBooking`); this is
   * a display estimate.
   */
  async availableCount(tenantId: string, assetTypeId: string, window?: { startDate: Date; endDate: Date }): Promise<number> {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const assetType = await tx.assetType.findUniqueOrThrow({ where: { id: assetTypeId } });
      if (!assetType.isPooled) {
        return tx.asset.count({ where: { assetTypeId, status: "AVAILABLE" } });
      }
      const now = new Date();
      return computePooledAvailableCount(tx, assetType, window?.startDate ?? now, window?.endDate ?? now);
    });
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

  /**
   * Catalog setup (Session 23) — the first write path for a tenant's own
   * AssetType/Asset rows; every one before this was seed-data-only.
   * `bookingModel`/`slug` are set once here and never editable via
   * `updateAssetType` (see the request schema's own doc comment).
   */
  async createAssetType(tenantId: string, input: CreateAssetTypeRequest) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const existing = await tx.assetType.findUnique({ where: { tenantId_slug: { tenantId, slug: input.slug } } });
      if (existing) throw new ConflictException(`An AssetType with slug "${input.slug}" already exists.`);

      return tx.assetType.create({
        data: {
          tenantId,
          name: input.name,
          slug: input.slug,
          bookingModel: input.bookingModel,
          attributesSchema: input.attributesSchema as Prisma.InputJsonValue,
          pricing: input.pricing as unknown as Prisma.InputJsonValue,
          photos: input.photos,
          isPooled: input.isPooled,
          isPublished: input.isPublished,
        },
      });
    });
  }

  async updateAssetType(tenantId: string, assetTypeId: string, patch: UpdateAssetTypeRequest) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const existing = await tx.assetType.findUnique({ where: { id: assetTypeId } });
      if (!existing) throw new NotFoundException("AssetType not found.");

      return tx.assetType.update({
        where: { id: assetTypeId },
        data: {
          name: patch.name,
          attributesSchema: patch.attributesSchema as Prisma.InputJsonValue | undefined,
          pricing: patch.pricing as unknown as Prisma.InputJsonValue | undefined,
          photos: patch.photos,
          isPooled: patch.isPooled,
          isPublished: patch.isPublished,
        },
      });
    });
  }

  async createAsset(tenantId: string, input: CreateAssetRequest) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const assetType = await tx.assetType.findUnique({ where: { id: input.assetTypeId } });
      if (!assetType) throw new NotFoundException("AssetType not found.");
      const location = await tx.location.findUnique({ where: { id: input.locationId } });
      if (!location) throw new NotFoundException("Location not found.");

      const existing = await tx.asset.findUnique({
        where: { tenantId_locationId_code: { tenantId, locationId: input.locationId, code: input.code } },
      });
      if (existing) throw new ConflictException(`A unit with code "${input.code}" already exists at this location.`);

      return tx.asset.create({
        data: {
          tenantId,
          locationId: input.locationId,
          assetTypeId: input.assetTypeId,
          code: input.code,
          attributes: input.attributes as Prisma.InputJsonValue,
        },
      });
    });
  }

  async updateAssetStatus(tenantId: string, assetId: string, status: string, statusReason?: string) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const existing = await tx.asset.findUnique({ where: { id: assetId } });
      if (!existing) throw new NotFoundException("Asset not found.");
      if (existing.status !== "AVAILABLE" && existing.status !== "MAINTENANCE" && existing.status !== "RETIRED") {
        throw new ConflictException(
          `Unit is currently ${existing.status} (tied to an active booking) — status can only be changed manually when it's AVAILABLE, MAINTENANCE, or RETIRED.`,
        );
      }
      return tx.asset.update({
        where: { id: assetId },
        data: { status: status as never, statusReason },
      });
    });
  }
}
