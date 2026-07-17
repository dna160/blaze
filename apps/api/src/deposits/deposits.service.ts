import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { money } from "@rentos/domain";
import { recordDepositRefundedEntries } from "@rentos/database";

import { PAYMENT_PROVIDER, type PaymentProvider } from "../payments/payment-provider.interface.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

/**
 * PRD §7.2.4: "refund workflow with approval + disbursement via Xendit
 * payout." v1 keeps this to the two-step request/approve shape the PRD
 * describes — no partial-application-against-damages workflow yet
 * (Deposit.appliedAmount / PARTIALLY_APPLIED / APPLIED exist in schema
 * for that, unused today; see docs/HANDOFF.md).
 */
@Injectable()
export class DepositsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  listForBooking(tenantId: string, bookingId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) => tx.deposit.findMany({ where: { bookingId } }));
  }

  async requestRefund(tenant: ResolvedTenant, depositId: string) {
    const deposit = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.deposit.findUnique({ where: { id: depositId } }),
    );
    if (!deposit) throw new NotFoundException("Deposit not found.");
    if (deposit.status !== "HELD") {
      throw new ConflictException(`Deposit is ${deposit.status}, cannot request refund.`);
    }
    return this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.deposit.update({ where: { id: depositId }, data: { status: "REFUND_REQUESTED" } }),
    );
  }

  async approveRefund(tenant: ResolvedTenant, approverUserId: string, depositId: string) {
    const deposit = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.deposit.findUnique({ where: { id: depositId } }),
    );
    if (!deposit) throw new NotFoundException("Deposit not found.");
    if (deposit.status !== "REFUND_REQUESTED") {
      throw new ConflictException(`Deposit is ${deposit.status}, not awaiting refund approval.`);
    }

    // Best-effort link back to the original payment for a real gateway
    // refund reference; MockPaymentProvider doesn't need this to be a real ref.
    const originalPayment = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.payment.findFirst({
        where: { status: "SUCCEEDED", invoice: { bookingId: deposit.bookingId, lines: { some: { lineType: "DEPOSIT" } } } },
        orderBy: { createdAt: "asc" },
      }),
    );

    const refundAmount = money(deposit.amount.toString());
    const refundResult = await this.provider.refund(originalPayment?.providerRef ?? deposit.id, refundAmount);

    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const updated = await tx.deposit.update({
        where: { id: depositId },
        data: {
          status: "REFUNDED",
          refundedAt: new Date(),
          refundApprovedByUserId: approverUserId,
          payoutRef: refundResult.providerRef,
        },
      });
      await recordDepositRefundedEntries(tx, tenant.id, depositId, deposit.amount.toString());
      return updated;
    });
  }
}
