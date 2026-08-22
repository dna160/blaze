import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { generateRentalOrderInvoice, markInvoicePaid } from "@rentos/database";
import { monthlyPeriodEnd, rentalOrderFsm } from "@rentos/domain";

import { NotificationsService } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";
import { WaitlistService } from "../waitlist/waitlist.service.js";

/**
 * BUILD-SPEC C4 — the discrete monthly rental lifecycle. Every month is its own
 * closed-ended RentalOrder; renewal (H-14 offer → confirm) produces a NEW order,
 * never a silent extension. Declining (or B1's H-7 no-reply, applied by the
 * renewal-timeout worker job) releases the unit to the waitlist.
 */
@Injectable()
export class RentalOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly waitlist: WaitlistService,
  ) {}

  get(tenant: ResolvedTenant, id: string) {
    return this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.rentalOrder.findUniqueOrThrow({ where: { id }, include: { invoices: true, contracts: true } }),
    );
  }

  listPending(tenant: ResolvedTenant) {
    return this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.rentalOrder.findMany({ where: { status: "PENDING_APPROVAL" }, orderBy: { createdAt: "asc" } }),
    );
  }

  /**
   * Customer request-to-book (#11: customer picks asset TYPE + months, NOT a
   * specific unit). Creates a PENDING_APPROVAL order with a frozen price
   * snapshot. `months` must be a whole number (C3 enforced by monthlyPeriodEnd).
   */
  async createOrder(
    tenant: ResolvedTenant,
    params: { customerId: string; assetTypeId: string; months: number; periodStart: Date; masterAgreementId?: string },
  ) {
    if (!Number.isInteger(params.months) || params.months < 1) {
      throw new BadRequestException("months must be a whole number (monthly-only billing, C3).");
    }
    const periodEnd = monthlyPeriodEnd(params.periodStart, params.months);
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const assetType = await tx.assetType.findUniqueOrThrow({ where: { id: params.assetTypeId } });
      const order = await tx.rentalOrder.create({
        data: {
          tenantId: tenant.id,
          customerId: params.customerId,
          assetTypeId: params.assetTypeId,
          masterAgreementId: params.masterAgreementId,
          status: "PENDING_APPROVAL",
          periodStart: params.periodStart,
          periodEnd,
          priceSnapshot: assetType.pricing as object,
        },
      });
      await this.event(tx, tenant.id, order.id, null, "PENDING_APPROVAL", "STAFF", undefined, "Order requested");
      return order;
    });
  }

  /**
   * Staff approval assigns the specific unit (#11) and issues the contract +
   * first invoice. Deposit is charged only on a first order (no previousOrderId).
   */
  async approve(tenant: ResolvedTenant, id: string, userId: string, assetId: string) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const order = await tx.rentalOrder.findUniqueOrThrow({ where: { id } });
      const { to } = await rentalOrderFsm.fire(order.status as never, "APPROVE", { invoicePaid: false, contractSigned: false });

      const asset = await tx.asset.findUniqueOrThrow({ where: { id: assetId } });
      if (asset.assetTypeId !== order.assetTypeId) throw new BadRequestException("Assigned unit is the wrong asset type.");
      if (asset.status !== "AVAILABLE") throw new BadRequestException("Assigned unit is not available.");

      await tx.rentalOrder.update({ where: { id }, data: { status: to, assetId, approvedByUserId: userId } });
      await tx.asset.update({ where: { id: assetId }, data: { status: "RESERVED" } });
      await this.event(tx, tenant.id, id, order.status as never, to, "STAFF", userId, "Approved + unit assigned");

      return this.issue(
        tx,
        tenant,
        {
          id: order.id,
          customerId: order.customerId,
          periodStart: order.periodStart,
          periodEnd: order.periodEnd,
          priceSnapshot: order.priceSnapshot,
          status: to,
        },
        { includeDeposit: order.previousOrderId === null },
      );
    });
  }

  /** Generate the contract (mock e-sign) + invoice and move to AWAITING_PAYMENT. */
  private async issue(
    tx: Parameters<Parameters<PrismaService["runInTenantContext"]>[1]>[0],
    tenant: ResolvedTenant,
    order: { id: string; customerId: string; periodStart: Date; periodEnd: Date; priceSnapshot: unknown; status: string },
    opts: { includeDeposit: boolean },
  ) {
    await tx.contract.create({
      data: {
        tenantId: tenant.id,
        rentalOrderId: order.id,
        templateVersion: "v1",
        esignProvider: "MOCK",
        esignStatus: "SIGNED",
        signedAt: new Date(),
      },
    });
    const invoice = await generateRentalOrderInvoice(
      tx,
      tenant.id,
      tenant.slug,
      tenant.isPkp,
      {
        id: order.id,
        customerId: order.customerId,
        periodStart: order.periodStart,
        periodEnd: order.periodEnd,
        priceSnapshot: order.priceSnapshot,
      },
      opts,
    );
    const updated = await tx.rentalOrder.update({ where: { id: order.id }, data: { status: "AWAITING_PAYMENT" } });
    await this.event(tx, tenant.id, order.id, order.status as never, "AWAITING_PAYMENT", "SYSTEM", undefined, "Contract + invoice issued");
    return { order: updated, invoiceId: invoice.id };
  }

  /** Mark the order's invoice paid and activate (both gates: paid + signed). */
  async markPaidAndActivate(tenant: ResolvedTenant, orderId: string, invoiceId: string) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      await markInvoicePaid(tx, invoiceId);
      const order = await tx.rentalOrder.findUniqueOrThrow({ where: { id: orderId }, include: { contracts: true } });
      const contractSigned = order.contracts.some((c) => c.esignStatus === "SIGNED");
      const { to } = await rentalOrderFsm.fire(order.status as never, "ACTIVATE", { invoicePaid: true, contractSigned });
      await tx.rentalOrder.update({ where: { id: orderId }, data: { status: to } });
      if (order.assetId) await tx.asset.update({ where: { id: order.assetId }, data: { status: "OCCUPIED" } });
      await this.event(tx, tenant.id, orderId, order.status as never, to, "SYSTEM", undefined, "Payment received — activated");
      return { status: to };
    });
  }

  /** H-14 renewal offer: ACTIVE → RENEWAL_OFFERED, notify customer AND admin (#42). */
  async offerRenewal(tenant: ResolvedTenant, id: string) {
    const result = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const order = await tx.rentalOrder.findUniqueOrThrow({ where: { id }, include: { customer: true } });
      const { to } = await rentalOrderFsm.fire(order.status as never, "OFFER_RENEWAL", { invoicePaid: true, contractSigned: true });
      await tx.rentalOrder.update({ where: { id }, data: { status: to, renewalOfferedAt: new Date() } });
      await this.event(tx, tenant.id, id, order.status as never, to, "SYSTEM", undefined, "H-14 renewal offered");
      return { customer: order.customer };
    });
    await this.notifications.notify({
      tenantId: tenant.id,
      customerId: result.customer.id,
      channel: "WHATSAPP",
      templateKey: "renewal_offer_h14",
      recipient: result.customer.phone,
      variables: { orderId: id },
    });
    return { status: "RENEWAL_OFFERED" };
  }

  /** Customer confirms: spawn the successor order (renewal chain) + issue it. */
  async confirmRenewal(tenant: ResolvedTenant, id: string) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const order = await tx.rentalOrder.findUniqueOrThrow({ where: { id } });
      const { to } = await rentalOrderFsm.fire(order.status as never, "CONFIRM_RENEWAL", { invoicePaid: true, contractSigned: true });
      await tx.rentalOrder.update({ where: { id }, data: { status: to, renewalRespondedAt: new Date() } });
      await this.event(tx, tenant.id, id, order.status as never, to, "CUSTOMER", order.customerId, "Renewal confirmed");

      const nextStart = order.periodEnd;
      const successor = await tx.rentalOrder.create({
        data: {
          tenantId: tenant.id,
          masterAgreementId: order.masterAgreementId,
          customerId: order.customerId,
          assetTypeId: order.assetTypeId,
          assetId: order.assetId,
          previousOrderId: order.id,
          status: "APPROVED",
          periodStart: nextStart,
          periodEnd: monthlyPeriodEnd(nextStart, 1),
          priceSnapshot: order.priceSnapshot as object,
        },
      });
      // Renewal carries the deposit forward — no new deposit line.
      const issued = await this.issue(
        tx,
        tenant,
        {
          id: successor.id,
          customerId: successor.customerId,
          periodStart: successor.periodStart,
          periodEnd: successor.periodEnd,
          priceSnapshot: successor.priceSnapshot,
          status: successor.status,
        },
        { includeDeposit: false },
      );
      return { successorOrderId: successor.id, invoiceId: issued.invoiceId };
    });
  }

  /**
   * Customer declines (or B1: H-7 no-reply, applied by renewal-timeout job).
   * Releases the unit and fires the waitlist (C5). The declined order completes
   * at period end (worker COMPLETE), but the unit is freed now so the next
   * tenant can be armed → contracted immediately.
   */
  async declineRenewal(tenant: ResolvedTenant, id: string, reason = "Customer declined renewal") {
    const releasedAssetId = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const order = await tx.rentalOrder.findUniqueOrThrow({ where: { id } });
      const { to } = await rentalOrderFsm.fire(order.status as never, "DECLINE_RENEWAL", { invoicePaid: true, contractSigned: true });
      await tx.rentalOrder.update({ where: { id }, data: { status: to, renewalRespondedAt: new Date() } });
      await this.event(tx, tenant.id, id, order.status as never, to, "CUSTOMER", order.customerId, reason);
      if (order.assetId) {
        await tx.asset.update({ where: { id: order.assetId }, data: { status: "AVAILABLE" } });
      }
      return order.assetId;
    });
    if (releasedAssetId) {
      const fired = await this.waitlist.fireNext(tenant, releasedAssetId);
      return { status: "RENEWAL_DECLINED", waitlistFiredOrderId: fired?.orderId ?? null };
    }
    return { status: "RENEWAL_DECLINED", waitlistFiredOrderId: null };
  }

  private event(
    tx: Parameters<Parameters<PrismaService["runInTenantContext"]>[1]>[0],
    tenantId: string,
    rentalOrderId: string,
    fromStatus: string | null,
    toStatus: string,
    actorType: string,
    actorId?: string,
    reason?: string,
  ) {
    return tx.rentalOrderEvent.create({
      data: {
        tenantId,
        rentalOrderId,
        fromStatus: fromStatus as never,
        toStatus: toStatus as never,
        actorType,
        actorId,
        reason,
      },
    });
  }
}
