import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { money } from "@rentos/domain";
import { recordDepositAppliedEntries, recordDepositRefundedEntries } from "@rentos/database";

import { AuditService } from "../audit/audit.service.js";
import { PAYMENT_PROVIDER, type PaymentProvider } from "../payments/payment-provider.interface.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

/**
 * PRD §7.2.4: "held as liability... applied against damages/final
 * invoice, refund workflow with approval + disbursement." Two
 * independent things can happen to a HELD deposit, in either order or
 * combination: staff apply part of it against damages (`applyToDamages`),
 * and/or the remaining balance goes through request/approve refund. A
 * deposit is never refunded for more than `amount - appliedAmount` —
 * whatever's already been applied is gone for good.
 */
@Injectable()
export class DepositsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly audit: AuditService,
  ) {}

  listForBooking(tenantId: string, bookingId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) => tx.deposit.findMany({ where: { bookingId } }));
  }

  /** Console deposits queue (PRD §7.2.4 refund workflow) — filterable by status, e.g. ?status=REFUND_REQUESTED for the approval queue. */
  listAll(tenantId: string, filters: { status?: string }) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.deposit.findMany({
        where: { status: filters.status as never },
        include: { booking: { include: { customer: true, asset: true } } },
        orderBy: { createdAt: "desc" },
      }),
    );
  }

  /** PRD Appendix C RBAC: same bar as issuing credit notes (Super Admin, Finance Admin) — a unilateral deduction from customer funds. */
  async applyToDamages(tenant: ResolvedTenant, staffUserId: string, depositId: string, amount: string, reason: string) {
    const deposit = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.deposit.findUnique({ where: { id: depositId } }),
    );
    if (!deposit) throw new NotFoundException("Deposit not found.");
    if (deposit.status !== "HELD" && deposit.status !== "PARTIALLY_APPLIED") {
      throw new ConflictException(`Deposit is ${deposit.status}, cannot apply against damages.`);
    }

    const applyAmount = money(amount);
    const remaining = money(deposit.amount.toString()).minus(money(deposit.appliedAmount.toString()));
    if (applyAmount.lessThanOrEqualTo(0)) {
      throw new BadRequestException("Applied amount must be positive.");
    }
    if (applyAmount.greaterThan(remaining)) {
      throw new BadRequestException(`Cannot apply more than the remaining deposit balance (${remaining.toString()}).`);
    }

    const newAppliedAmount = money(deposit.appliedAmount.toString()).plus(applyAmount);
    const newStatus = newAppliedAmount.greaterThanOrEqualTo(money(deposit.amount.toString())) ? "APPLIED" : "PARTIALLY_APPLIED";

    const updated = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const result = await tx.deposit.update({
        where: { id: depositId },
        data: { appliedAmount: newAppliedAmount.toString(), status: newStatus },
      });
      await recordDepositAppliedEntries(tx, tenant.id, depositId, applyAmount.toString());
      return result;
    });

    await this.audit.record({
      tenantId: tenant.id,
      actorUserId: staffUserId,
      action: "DEPOSIT_APPLIED",
      entityType: "Deposit",
      entityId: depositId,
      metadata: { amount: applyAmount.toString(), reason },
    });

    return updated;
  }

  async requestRefund(tenant: ResolvedTenant, depositId: string) {
    const deposit = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.deposit.findUnique({ where: { id: depositId } }),
    );
    if (!deposit) throw new NotFoundException("Deposit not found.");
    if (deposit.status !== "HELD" && deposit.status !== "PARTIALLY_APPLIED") {
      throw new ConflictException(`Deposit is ${deposit.status}, cannot request refund.`);
    }
    const remaining = money(deposit.amount.toString()).minus(money(deposit.appliedAmount.toString()));
    if (remaining.lessThanOrEqualTo(0)) {
      throw new ConflictException("Nothing left to refund — the full deposit has been applied against damages.");
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

    // Only the unapplied remainder is ever refunded — whatever's already
    // been applied against damages doesn't come back.
    const refundAmount = money(deposit.amount.toString()).minus(money(deposit.appliedAmount.toString()));

    // Best-effort link back to the original payment for a real gateway
    // refund reference; MockPaymentProvider doesn't need this to be a real ref.
    const originalPayment = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.payment.findFirst({
        where: { status: "SUCCEEDED", invoice: { bookingId: deposit.bookingId, lines: { some: { lineType: "DEPOSIT" } } } },
        orderBy: { createdAt: "asc" },
      }),
    );

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
      await recordDepositRefundedEntries(tx, tenant.id, depositId, refundAmount.toString());
      return updated;
    });
  }
}
