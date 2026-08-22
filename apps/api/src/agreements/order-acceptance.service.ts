import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

export interface AcceptanceEvidence {
  method: "OTP" | "CLICK";
  ipAddress?: string;
  userAgent?: string;
  otpChallengeId?: string;
  proof?: Record<string, unknown>;
}

/**
 * BUILD-SPEC §5 — per-order acceptance. A monthly RentalOrder is accepted against
 * the customer's already-certified master agreement via OTP (or one-tap click),
 * consuming NO certified signature. UU ITE Art. 11: the acceptance is made with a
 * factor under the signatory's sole control (the OTP), against an identity already
 * certified under the master — real evidentiary weight for the order, at ~0 cost.
 *
 * The record is the exportable evidence bundle: timestamp, IP, device, OTP proof.
 */
@Injectable()
export class OrderAcceptanceService {
  constructor(private readonly prisma: PrismaService) {}

  async recordAcceptance(tenant: ResolvedTenant, rentalOrderId: string, evidence: AcceptanceEvidence) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const order = await tx.rentalOrder.findUnique({ where: { id: rentalOrderId }, include: { masterAgreement: true } });
      if (!order) throw new NotFoundException("Rental order not found.");
      if (!order.masterAgreementId || order.masterAgreement?.status !== "SIGNED") {
        throw new BadRequestException("Order-level acceptance requires a SIGNED master agreement (§5).");
      }
      return tx.orderAcceptance.create({
        data: {
          tenantId: tenant.id,
          rentalOrderId,
          method: evidence.method,
          ipAddress: evidence.ipAddress,
          userAgent: evidence.userAgent,
          otpChallengeId: evidence.otpChallengeId,
          proof: (evidence.proof ?? {}) as object,
        },
      });
    });
  }

  /** The exportable evidence bundle for an order's acceptances. */
  listForOrder(tenant: ResolvedTenant, rentalOrderId: string) {
    return this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.orderAcceptance.findMany({ where: { rentalOrderId }, orderBy: { acceptedAt: "asc" } }),
    );
  }
}
