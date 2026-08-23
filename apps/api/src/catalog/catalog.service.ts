import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  computePooledAvailableCount,
  countAvailableStorageAssets,
  resolveBlackoutMonths,
  resolveInvoiceLeadDays,
  toPricingConfig,
  type Prisma,
} from "@rentos/database";
import { computeTermSchedule, getBookingModelStrategy, termEndDate, type BookingWindow } from "@rentos/domain";
import type {
  CreateAssetRequest,
  CreateAssetTypeRequest,
  LocationAssetTypeSummary,
  QuoteRequest,
  QuoteResponse,
  StorageAvailabilityQuery,
  StorageAvailabilityResponse,
  UpdateAssetTypeRequest,
  UpsertLocationRequest,
} from "@rentos/contracts";

import { PrismaService } from "../prisma/prisma.service.js";

const SIZE_CLASSES = new Set(["SMALL", "MEDIUM", "LARGE"]);

function sizeClassOf(attributesSchema: unknown): "SMALL" | "MEDIUM" | "LARGE" | null {
  const raw = (attributesSchema as { sizeClass?: unknown } | null)?.sizeClass;
  return typeof raw === "string" && SIZE_CLASSES.has(raw) ? (raw as "SMALL" | "MEDIUM" | "LARGE") : null;
}

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
   * Live price preview (public, unauthenticated — same trust level as the
   * catalog listing itself). Read-only — reuses the exact
   * BookingModelStrategy math a real booking will be charged via
   * `computeInitialInvoice`, so the storefront's Daily/Weekly/Monthly
   * tier picker can never drift from what the customer is actually
   * charged the way a hand-duplicated client-side calculation could.
   */
  async quote(
    tenant: { id: string; isPkp: boolean; featureFlags: Record<string, unknown> },
    assetTypeId: string,
    request: QuoteRequest,
  ): Promise<QuoteResponse> {
    const assetType = await this.getAssetType(tenant.id, assetTypeId);
    const strategy = getBookingModelStrategy(assetType.bookingModel);
    const pricing = toPricingConfig(assetType.pricing);
    const tax = { isTenantPkp: tenant.isPkp };
    const startDate = new Date(request.startDate);
    const window: BookingWindow = {
      startDate,
      endDate: request.endDate ? new Date(request.endDate) : undefined,
      rateTier: request.rateTier,
      termMonths: assetType.bookingModel === "RECURRING_LEASE" ? request.termMonths : undefined,
    };
    let draft;
    try {
      draft = strategy.computeInitialInvoice(window, pricing, tax);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : "Could not compute a quote for these dates.");
    }

    // PRD v2 D1 — preview the whole payment schedule for a term, using the
    // same cycle math the real SCHEDULED invoices will be created with.
    let schedule: QuoteResponse["schedule"];
    if (window.termMonths && strategy.computeCycleInvoice) {
      const periods = computeTermSchedule(startDate, window.termMonths, { leadDays: resolveInvoiceLeadDays(tenant.featureFlags) });
      schedule = periods.map((p) => {
        const total = p.index === 0 ? draft.totalAmount : strategy.computeCycleInvoice!(p.periodStart, p.periodEnd, pricing, tax).totalAmount;
        return {
          index: p.index,
          periodStart: p.periodStart.toISOString(),
          periodEnd: p.periodEnd.toISOString(),
          dueDate: p.dueDate.toISOString(),
          totalAmount: total.toString(),
        };
      });
    }

    return {
      currency: assetType.pricing && typeof assetType.pricing === "object" && "currency" in assetType.pricing
        ? String((assetType.pricing as { currency: unknown }).currency)
        : "IDR",
      lines: draft.lines.map((l) => ({ description: l.description, amount: l.amount.toString(), lineType: l.lineType })),
      subtotal: draft.subtotal.toString(),
      taxAmount: draft.taxAmount.toString(),
      totalAmount: draft.totalAmount.toString(),
      periodStart: draft.periodStart.toISOString(),
      periodEnd: draft.periodEnd.toISOString(),
      schedule,
      termMonths: window.termMonths as QuoteResponse["termMonths"],
    };
  }

  /**
   * PRD v2 §4.3 — the live check behind storefront step 3: is a unit of
   * this size at this branch free for [check-in, check-in + term), with
   * the blackout month applied to every committed booking? Also reports
   * how many WAITLISTED requests for the same branch + size are ahead, so
   * a full branch can say "you'd be #3 on the waitlist" before submission.
   */
  async storageAvailability(
    tenant: { id: string; featureFlags: Record<string, unknown> },
    query: StorageAvailabilityQuery,
    customerId?: string,
  ): Promise<StorageAvailabilityResponse> {
    const startDate = new Date(query.startDate);
    const blackoutMonths = resolveBlackoutMonths(tenant.featureFlags);
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const assetType = await tx.assetType.findUnique({ where: { id: query.assetTypeId } });
      if (!assetType || !assetType.isPublished) throw new NotFoundException("AssetType not found.");
      if (assetType.bookingModel !== "RECURRING_LEASE") {
        throw new BadRequestException("Term availability only applies to RECURRING_LEASE listings.");
      }
      const availableCount = await countAvailableStorageAssets(
        tx,
        query.assetTypeId,
        query.locationId,
        { startDate, termMonths: query.termMonths },
        { blackoutMonths, customerId },
      );
      const waitlistAhead = await tx.booking.count({
        where: { status: "WAITLISTED", assetTypeId: query.assetTypeId, locationId: query.locationId },
      });
      return {
        available: availableCount > 0,
        availableCount,
        waitlistAhead,
        blackoutMonths,
        endDate: termEndDate(startDate, query.termMonths).toISOString(),
      };
    });
  }

  /**
   * PRD v2 §4.1 storefront step 2: the sizes a branch sells, each with
   * how many units are free right now for a 1-month window (display
   * estimate — the real gate is `storageAvailability` with the customer's
   * actual dates). Only published RECURRING_LEASE types with at least one
   * in-service unit at the branch appear.
   */
  async locationAssetTypes(tenant: { id: string; featureFlags: Record<string, unknown> }, locationId: string): Promise<LocationAssetTypeSummary[]> {
    const blackoutMonths = resolveBlackoutMonths(tenant.featureFlags);
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const location = await tx.location.findUnique({ where: { id: locationId } });
      if (!location) throw new NotFoundException("Location not found.");
      const assetTypes = await tx.assetType.findMany({
        where: { isPublished: true, bookingModel: "RECURRING_LEASE", assets: { some: { locationId, status: { not: "RETIRED" } } } },
        include: { _count: { select: { assets: { where: { locationId, status: { not: "RETIRED" } } } } } },
        orderBy: { createdAt: "asc" },
      });
      const now = new Date();
      const summaries: LocationAssetTypeSummary[] = [];
      for (const at of assetTypes) {
        const availableNow = await countAvailableStorageAssets(tx, at.id, locationId, { startDate: now, termMonths: 1 }, { blackoutMonths });
        summaries.push({
          assetType: at as unknown as LocationAssetTypeSummary["assetType"],
          sizeClass: sizeClassOf(at.attributesSchema),
          unitCount: at._count.assets,
          availableNow,
        });
      }
      const order = { SMALL: 0, MEDIUM: 1, LARGE: 2 } as const;
      return summaries.sort((a, b) => (a.sizeClass ? order[a.sizeClass] : 3) - (b.sizeClass ? order[b.sizeClass] : 3));
    });
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

  /** First write path for Location rows (PRD v2 §5.3) — name/address plus the coordinates the storefront map needs. */
  createLocation(tenantId: string, input: UpsertLocationRequest) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.location.create({
        data: {
          tenantId,
          name: input.name,
          address: input.address ?? null,
          timezone: input.timezone ?? "Asia/Jakarta",
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
        },
      }),
    );
  }

  async updateLocation(tenantId: string, locationId: string, patch: UpsertLocationRequest) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const existing = await tx.location.findUnique({ where: { id: locationId } });
      if (!existing) throw new NotFoundException("Location not found.");
      return tx.location.update({
        where: { id: locationId },
        data: {
          name: patch.name,
          address: patch.address === undefined ? undefined : patch.address,
          timezone: patch.timezone,
          latitude: patch.latitude === undefined ? undefined : patch.latitude,
          longitude: patch.longitude === undefined ? undefined : patch.longitude,
        },
      });
    });
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

      // C1 made a Tenant one branch and Asset.locationId nullable, so unit codes
      // are unique per TENANT now (@@unique([tenantId, code])) rather than per
      // (tenant, location) — same "no duplicate code in this branch" rule, one
      // level up. The old tenantId_locationId_code index is gone.
      const existing = await tx.asset.findUnique({ where: { tenantId_code: { tenantId, code: input.code } } });
      if (existing) throw new ConflictException(`A unit with code "${input.code}" already exists in this branch.`);

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
