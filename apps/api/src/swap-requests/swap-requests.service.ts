import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@rentos/database";
import { assetFsm, computeSwapProration } from "@rentos/domain";

import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

const SWAPPABLE_BOOKING_STATUSES = new Set(["ACTIVE", "RENEWING"]);

/**
 * PRD §7.1.4 "request upgrade/downsize... creates a swap request routed to
 * admin" + persona table's "Grow/Shrink: swap request in portal → prorated
 * switch." v1 reassigns the asset and re-snapshots pricing for the *next*
 * invoice cycle onward, and computes (via `computeSwapProration`) exactly
 * what's owed or owed-back for the days remaining in the CURRENT,
 * already-billed period — but deliberately does NOT auto-generate a
 * mid-cycle invoice/credit note for that number. A downsize produces a
 * negative adjustment, and this invoice model has no negative-amount
 * convention anything downstream (payments, dunning, the storefront UI)
 * is built to represent. The computed number is stored on the SwapRequest
 * row and surfaced to staff, who act on it with the tools that already
 * exist: a manual credit note for a downsize, a manual charge for an
 * upgrade. Tracked in docs/HANDOFF.md.
 */
@Injectable()
export class SwapRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenant: ResolvedTenant, customerId: string, bookingId: string, requestedAssetTypeId: string, reason?: string) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking) throw new NotFoundException("Booking not found.");
      if (booking.customerId !== customerId) throw new ForbiddenException("This booking does not belong to you.");
      if (!SWAPPABLE_BOOKING_STATUSES.has(booking.status)) {
        throw new ConflictException(`Booking is ${booking.status} — swap requests require an active lease.`);
      }

      const requestedAssetType = await tx.assetType.findUnique({ where: { id: requestedAssetTypeId } });
      if (!requestedAssetType || !requestedAssetType.isPublished) throw new NotFoundException("AssetType not found.");
      if (requestedAssetType.id === booking.assetTypeId) {
        throw new BadRequestException("This booking is already on that unit type.");
      }

      const existingPending = await tx.swapRequest.findFirst({ where: { bookingId, status: "PENDING" } });
      if (existingPending) throw new ConflictException("A swap request is already pending for this booking.");

      return tx.swapRequest.create({
        data: { tenantId: tenant.id, bookingId, requestedAssetTypeId, reason, status: "PENDING" },
      });
    });
  }

  listQueue(tenantId: string, filters: { status?: string }) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.swapRequest.findMany({
        where: { status: (filters.status as never) ?? "PENDING" },
        include: {
          booking: { include: { customer: true, asset: true, assetType: true } },
          requestedAssetType: true,
        },
        orderBy: { createdAt: "asc" },
      }),
    );
  }

  listForBooking(tenantId: string, bookingId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.swapRequest.findMany({
        where: { bookingId },
        include: { requestedAssetType: true },
        orderBy: { createdAt: "desc" },
      }),
    );
  }

  async approve(tenant: ResolvedTenant, approverUserId: string, swapRequestId: string, newAssetId: string) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const swapRequest = await tx.swapRequest.findUnique({ where: { id: swapRequestId } });
      if (!swapRequest) throw new NotFoundException("Swap request not found.");
      if (swapRequest.status !== "PENDING") throw new ConflictException(`Swap request is ${swapRequest.status}, not pending.`);

      const booking = await tx.booking.findUnique({ where: { id: swapRequest.bookingId } });
      if (!booking) throw new NotFoundException("Booking not found.");
      if (!SWAPPABLE_BOOKING_STATUSES.has(booking.status)) {
        throw new ConflictException(`Booking is ${booking.status} — can no longer complete this swap.`);
      }

      const newAsset = await tx.asset.findUnique({ where: { id: newAssetId } });
      if (!newAsset) throw new NotFoundException("Replacement unit not found.");
      if (newAsset.assetTypeId !== swapRequest.requestedAssetTypeId) {
        throw new BadRequestException("Replacement unit is not the requested unit type.");
      }
      if (newAsset.status !== "AVAILABLE") throw new ConflictException(`Unit ${newAsset.code} is not available.`);

      const newAssetType = await tx.assetType.findUniqueOrThrow({ where: { id: swapRequest.requestedAssetTypeId } });
      const oldAssetId = booking.assetId;

      // Current billing period comes from the booking's most recently PAID
      // invoice — the actual, real period the customer paid for, not a
      // date derived purely from anchorDay math (which could drift from
      // what was really invoiced, e.g. after a credited/replacement invoice).
      const lastPaidInvoice = await tx.invoice.findFirst({
        where: { bookingId: booking.id, status: "PAID", periodStart: { not: null }, periodEnd: { not: null } },
        orderBy: { periodEnd: "desc" },
      });
      let prorationNetAdjustment: string | null = null;
      let prorationDaysRemaining: number | null = null;
      if (lastPaidInvoice?.periodStart && lastPaidInvoice.periodEnd) {
        const oldPricing = booking.priceSnapshot as { basePrice: number };
        const newPricing = newAssetType.pricing as { basePrice: number };
        const proration = computeSwapProration({
          oldMonthlyRate: oldPricing.basePrice,
          newMonthlyRate: newPricing.basePrice,
          periodStart: lastPaidInvoice.periodStart,
          periodEnd: lastPaidInvoice.periodEnd,
          switchDate: new Date(),
        });
        prorationNetAdjustment = proration.netAdjustment.toString();
        prorationDaysRemaining = proration.daysRemaining;
      }

      await assetFsm.fire("AVAILABLE", "RESERVE", undefined);
      await assetFsm.fire("RESERVED", "MOVE_IN", undefined);
      await tx.asset.update({ where: { id: newAssetId }, data: { status: "OCCUPIED" } });

      if (oldAssetId) {
        await assetFsm.fire("OCCUPIED", "MOVE_OUT", undefined);
        await tx.asset.update({ where: { id: oldAssetId }, data: { status: "AVAILABLE" } });
      }

      // Pricing terms are normally frozen at booking submission and never
      // re-derived from AssetType (see Booking.priceSnapshot's doc comment)
      // — a swap is the one deliberate exception, since the customer is now
      // on a genuinely different unit type/rate.
      await tx.booking.update({
        where: { id: booking.id },
        data: { assetId: newAssetId, assetTypeId: newAssetType.id, priceSnapshot: newAssetType.pricing as Prisma.InputJsonValue },
      });

      await tx.bookingEvent.create({
        data: {
          tenantId: tenant.id,
          bookingId: booking.id,
          fromStatus: booking.status,
          toStatus: booking.status,
          actorType: "USER",
          actorId: approverUserId,
          reason: `Swap approved: ${newAsset.code} (${newAssetType.name})`,
        },
      });

      return tx.swapRequest.update({
        where: { id: swapRequestId },
        data: {
          status: "APPROVED",
          newAssetId,
          reviewedByUserId: approverUserId,
          reviewedAt: new Date(),
          prorationNetAdjustment,
          prorationDaysRemaining,
        },
      });
    });
  }

  async reject(tenant: ResolvedTenant, approverUserId: string, swapRequestId: string, rejectionReason: string) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const swapRequest = await tx.swapRequest.findUnique({ where: { id: swapRequestId } });
      if (!swapRequest) throw new NotFoundException("Swap request not found.");
      if (swapRequest.status !== "PENDING") throw new ConflictException(`Swap request is ${swapRequest.status}, not pending.`);

      return tx.swapRequest.update({
        where: { id: swapRequestId },
        data: { status: "REJECTED", reviewedByUserId: approverUserId, reviewedAt: new Date(), rejectionReason },
      });
    });
  }
}
