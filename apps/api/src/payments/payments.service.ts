import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { money } from "@rentos/domain";
import { recordPaymentReceivedEntries } from "@rentos/database";

import { BookingService } from "../booking/booking.service.js";
import { FinanceService } from "../finance/finance.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { PAYMENT_PROVIDER, type PaymentMethodValue, type PaymentProvider } from "./payment-provider.interface.js";

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly booking: BookingService,
    private readonly finance: FinanceService,
  ) {}

  /** Storefront checkout (PRD §7.1.3). */
  async initiate(tenant: ResolvedTenant, invoiceId: string, method: PaymentMethodValue) {
    const invoice = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.invoice.findUnique({ where: { id: invoiceId } }),
    );
    if (!invoice) throw new NotFoundException("Invoice not found.");
    if (invoice.status !== "ISSUED" && invoice.status !== "OVERDUE") {
      throw new ConflictException(`Invoice is ${invoice.status}, not payable.`);
    }

    const idempotencyKey = randomUUID();
    const result = await this.provider.initiate({
      invoiceId,
      amount: money(invoice.totalAmount.toString()),
      method,
      idempotencyKey,
    });

    const payment = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.payment.create({
        data: {
          tenantId: tenant.id,
          invoiceId,
          provider: this.provider.name,
          providerRef: result.providerRef,
          idempotencyKey,
          method,
          status: result.status === "SUCCEEDED" ? "SUCCEEDED" : "PENDING",
          amount: invoice.totalAmount,
          paidAt: result.status === "SUCCEEDED" ? new Date() : null,
        },
      }),
    );

    // Synchronous providers (mock, and some e-wallet flows) confirm immediately — finalize right away
    // rather than waiting for a webhook that will never arrive. Real async providers (Xendit VA/QRIS)
    // stay PENDING here and finalize exclusively through the webhook endpoint below.
    if (result.status === "SUCCEEDED") {
      await this.finalizePaidInvoice(tenant, invoiceId, payment.id);
    }

    return { paymentId: payment.id, status: payment.status, instructions: result.instructions };
  }

  /** Gateway webhook ingestion — idempotent via the WebhookEvent unique (provider, externalId) constraint (PRD §10 Availability). */
  async handleWebhook(tenant: ResolvedTenant, rawBody: string, headers: Record<string, string>) {
    const event = this.provider.parseWebhook(rawBody, headers);

    const alreadyProcessed = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const existing = await tx.webhookEvent.findUnique({
        where: { provider_externalId: { provider: this.provider.name, externalId: event.externalId } },
      });
      if (existing?.processedAt) return true;

      await tx.webhookEvent.upsert({
        where: { provider_externalId: { provider: this.provider.name, externalId: event.externalId } },
        create: {
          tenantId: tenant.id,
          provider: this.provider.name,
          externalId: event.externalId,
          eventType: event.eventType,
          payload: JSON.parse(rawBody),
        },
        update: {},
      });
      return false;
    });
    if (alreadyProcessed) return { status: "already_processed" };

    if (event.status === "SUCCEEDED") {
      const payment = await this.prisma.runInTenantContext(tenant.id, (tx) =>
        tx.payment.findFirst({ where: { providerRef: event.providerRef } }),
      );
      if (!payment) throw new NotFoundException(`No payment found for providerRef ${event.providerRef}.`);

      await this.prisma.runInTenantContext(tenant.id, (tx) =>
        tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCEEDED", paidAt: new Date() } }),
      );
      await this.finalizePaidInvoice(tenant, payment.invoiceId, payment.id);
    }

    await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.webhookEvent.update({
        where: { provider_externalId: { provider: this.provider.name, externalId: event.externalId } },
        data: { processedAt: new Date() },
      }),
    );
    return { status: "processed" };
  }

  /**
   * PRD §7.2.4: "manual payment entry (cash/transfer) with proof upload
   * and maker-checker (recorder != verifier)". Recording alone never
   * transitions the invoice/booking — only verify() does, and only when
   * performed by someone other than the recorder.
   */
  async recordManual(
    tenant: ResolvedTenant,
    recordedByUserId: string,
    invoiceId: string,
    method: "CASH" | "MANUAL_TRANSFER",
    proofUrl: string,
  ) {
    const invoice = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.invoice.findUnique({ where: { id: invoiceId } }),
    );
    if (!invoice) throw new NotFoundException("Invoice not found.");
    if (invoice.status !== "ISSUED" && invoice.status !== "OVERDUE") {
      throw new ConflictException(`Invoice is ${invoice.status}, not payable.`);
    }

    return this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.payment.create({
        data: {
          tenantId: tenant.id,
          invoiceId,
          provider: "MANUAL",
          idempotencyKey: randomUUID(),
          method,
          status: "PENDING",
          amount: invoice.totalAmount,
          recordedByUserId,
          proofUrl,
        },
      }),
    );
  }

  async verifyManual(tenant: ResolvedTenant, verifiedByUserId: string, paymentId: string) {
    const payment = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.payment.findUnique({ where: { id: paymentId } }),
    );
    if (!payment) throw new NotFoundException("Payment not found.");
    if (payment.provider !== "MANUAL" || !payment.recordedByUserId) {
      throw new BadRequestException("Only manually-recorded payments require verification.");
    }
    if (payment.status !== "PENDING") {
      throw new ConflictException(`Payment is ${payment.status}, not awaiting verification.`);
    }
    if (payment.recordedByUserId === verifiedByUserId) {
      throw new ForbiddenException("Maker-checker: the person who recorded a payment cannot verify it.");
    }

    await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.payment.update({
        where: { id: paymentId },
        data: { status: "SUCCEEDED", verifiedByUserId, paidAt: new Date() },
      }),
    );
    await this.finalizePaidInvoice(tenant, payment.invoiceId, payment.id);
    return { status: "verified" };
  }

  private async finalizePaidInvoice(tenant: ResolvedTenant, invoiceId: string, paymentId: string) {
    const { bookingId, hasDeposit, depositAmount } = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      await this.finance.markPaid(tx, invoiceId);
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true } });
      const depositLine = invoice.lines.find((l) => l.lineType === "DEPOSIT");
      const depositAmt = depositLine?.amount.toString();

      // The AR closed here is only the revenue portion — the deposit was never
      // in AR/Revenue to begin with (see packages/database/src/ledger.ts).
      const revenuePortion = (Number(invoice.totalAmount.toString()) - Number(depositAmt ?? 0)).toFixed(2);
      await recordPaymentReceivedEntries(tx, tenant.id, paymentId, invoiceId, revenuePortion);

      return {
        bookingId: invoice.bookingId,
        hasDeposit: Boolean(depositLine),
        depositAmount: depositAmt,
      };
    });

    if (bookingId) {
      await this.booking.handleInvoicePaid(tenant, bookingId, hasDeposit, depositAmount);
    }
  }
}
