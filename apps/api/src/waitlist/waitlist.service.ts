import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { fireNextWaitlistEntry } from "@rentos/database";

import { NotificationsService } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

const DEFAULT_TTL_HOURS = 24; // C5 rule 3 — payment TTL on a fired unit.

/**
 * BUILD-SPEC C5 — the waitlist is an armed, conditionally-approved booking.
 * Arming captures a customer with KYC done + a frozen price snapshot; FIRING a
 * released unit auto-generates a contract + invoice for exactly ONE entry, under
 * a row lock on the asset so two concurrent releases can never double-book it.
 */
@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private ttlHours(tenant: ResolvedTenant): number {
    const v = tenant.featureFlags?.["waitlistPaymentTtlHours"];
    return typeof v === "number" && v > 0 ? v : DEFAULT_TTL_HOURS;
  }

  /** Arm a waitlist entry. KYC must be VERIFIED — a fired entry auto-issues a contract. */
  async arm(tenant: ResolvedTenant, params: { customerId: string; assetTypeId: string }) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const customer = await tx.customer.findUniqueOrThrow({ where: { id: params.customerId } });
      if (customer.kycStatus !== "VERIFIED") {
        throw new BadRequestException("Customer KYC must be VERIFIED before joining the waitlist.");
      }
      const assetType = await tx.assetType.findUniqueOrThrow({ where: { id: params.assetTypeId } });

      const last = await tx.waitlistEntry.findFirst({
        where: { assetTypeId: params.assetTypeId, status: "ARMED" },
        orderBy: { position: "desc" },
      });
      const position = (last?.position ?? 0) + 1;

      return tx.waitlistEntry.create({
        data: {
          tenantId: tenant.id,
          assetTypeId: params.assetTypeId,
          customerId: params.customerId,
          position,
          status: "ARMED",
          kycVerified: true,
          priceSnapshot: assetType.pricing as object,
        },
      });
    });
  }

  listQueue(tenant: ResolvedTenant, assetTypeId: string) {
    return this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.waitlistEntry.findMany({ where: { assetTypeId }, orderBy: { position: "asc" } }),
    );
  }

  /**
   * C5 — fire the next armed entry for a just-released unit. Takes a row lock on
   * the asset (SELECT ... FOR UPDATE) BEFORE reading the queue, so concurrent
   * fire attempts serialize: the loser sees the asset already RESERVED and
   * returns null. Exactly one contract + invoice is ever created per released
   * unit. Returns the fired RentalOrder, or null if nothing fired.
   */
  async fireNext(tenant: ResolvedTenant, assetId: string) {
    const ttl = this.ttlHours(tenant);
    return this.prisma.runInTenantContext(tenant.id, (tx) =>
      fireNextWaitlistEntry(tx, {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        isPkp: tenant.isPkp,
        assetId,
        ttlHours: ttl,
      }),
    );
  }

  /**
   * C5 rule 3 — sweep FIRED entries whose payment TTL lapsed: void the fired
   * invoice, mark the entry EXPIRED, free the unit, and fire the next in queue.
   * Called by the waitlist-expiry worker job; returns the count expired.
   */
  async expireLapsed(tenant: ResolvedTenant, now = new Date()): Promise<number> {
    const lapsed = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.waitlistEntry.findMany({ where: { status: "FIRED", expiresAt: { lt: now } } }),
    );

    let expired = 0;
    for (const entry of lapsed) {
      if (!entry.firedRentalOrderId) continue;
      const releasedAssetId = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
        const order = await tx.rentalOrder.findUnique({ where: { id: entry.firedRentalOrderId! } });
        if (!order) return null;
        // Void the unpaid fired invoice(s).
        await tx.invoice.updateMany({
          where: { rentalOrderId: order.id, status: { in: ["ISSUED", "SCHEDULED", "OVERDUE"] } },
          data: { status: "VOID", voidedAt: now, voidReason: "Waitlist payment TTL lapsed" },
        });
        await tx.rentalOrder.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
        await tx.waitlistEntry.update({ where: { id: entry.id }, data: { status: "EXPIRED" } });
        if (order.assetId) {
          await tx.asset.update({ where: { id: order.assetId }, data: { status: "AVAILABLE" } });
        }
        return order.assetId;
      });
      expired++;
      // Fire the next in queue for the freed unit (own transaction / own lock).
      if (releasedAssetId) await this.fireNext(tenant, releasedAssetId);
    }
    if (expired > 0) this.logger.log(`Expired ${expired} waitlist fire(s) for tenant ${tenant.slug}`);
    return expired;
  }
}
