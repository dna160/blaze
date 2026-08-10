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

  // C5 rule 3 — the payment-TTL sweep (void fired invoice + reverse ledger, mark
  // EXPIRED, free unit, fire next) lives in the waitlist-expiry worker job, which
  // is the scheduled path. Keeping a second copy here risked drift and a
  // ledger-reversal omission, so it was removed — see apps/worker/src/jobs/
  // waitlist-expiry.job.ts.
}
