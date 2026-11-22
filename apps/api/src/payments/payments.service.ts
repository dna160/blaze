import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { applySettlement, expectedPphWithholding, money, SettlementError, settlementLedger, type PphType } from "@rentos/domain";
import { recordSettlementEntries } from "@rentos/database";

import { BookingService } from "../booking/booking.service.js";
import { FinanceService } from "../finance/finance.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { STORAGE_PROVIDER, type StorageProvider } from "../storage/storage-provider.interface.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";
import { WebhookDispatcherService } from "../webhook-dispatch/webhook-dispatch.service.js";

import { onlinePaymentsStatus } from "./online-payments.js";
import { PAYMENT_PROVIDER, type PaymentMethodValue, type PaymentProvider } from "./payment-provider.interface.js";

const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const MAX_FILE_BYTES = 8 * 1024 * 1024; // receipt/transfer-slip photos, not raw camera dumps

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly booking: BookingService,
    private readonly finance: FinanceService,
    private readonly webhooks: WebhookDispatcherService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Storefront checkout (PRD §7.1.3). */
  async initiate(tenant: ResolvedTenant, invoiceId: string, method: PaymentMethodValue) {
    const online = onlinePaymentsStatus(tenant.featureFlags);
    if (!online.enabled) {
      throw new ConflictException({
        code: "ONLINE_PAYMENTS_DISABLED",
        reason: online.reason,
        message: "Online payment is not available for this branch. Please pay by bank transfer and send the proof to our WhatsApp CS.",
      });
    }
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
    proof: { buffer: Buffer; mimetype: string; size: number },
    net: { amount?: number; pphWithheldAmount?: number; buktiPotong?: { buffer: Buffer; mimetype: string; size: number } } = {},
  ) {
    if (!ALLOWED_CONTENT_TYPES.has(proof.mimetype)) {
      throw new BadRequestException(`Unsupported file type "${proof.mimetype}". Use JPEG, PNG, WebP, or PDF.`);
    }
    if (proof.size > MAX_FILE_BYTES) {
      throw new BadRequestException("File too large — max 8MB.");
    }

    const invoice = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.invoice.findUnique({ where: { id: invoiceId } }),
    );
    if (!invoice) throw new NotFoundException("Invoice not found.");
    if (invoice.status !== "ISSUED" && invoice.status !== "OVERDUE") {
      throw new ConflictException(`Invoice is ${invoice.status}, not payable.`);
    }

    // PRD go-live 2 §10.1 — how much this transfer settles. Without PPh net
    // settlement (taxConfig.pphWithholdingEnabled off) it is exactly the
    // outstanding amount, as before; with it, a withholding customer may pay
    // net of PPh, and anyone may pay short (the balance stays open).
    const plan = await this.settlementPlan(tenant.id, invoiceId);
    const { pphEnabled, outstanding, expected } = plan;
    const withheld = net.pphWithheldAmount ?? (pphEnabled && expected && plan.settled === 0 && plan.pending === 0 ? expected.amount : 0);
    const amount = net.amount ?? outstanding - withheld;
    if (!pphEnabled) {
      if (withheld > 0) throw new BadRequestException("PPh net settlement is not enabled for this organization (taxConfig.pphWithholdingEnabled).");
      if (Math.abs(amount - outstanding) > 1) throw new BadRequestException(`Partial payments are not enabled: record the full outstanding Rp ${outstanding.toLocaleString("id-ID")}.`);
    }
    if (net.buktiPotong) this.assertFile(net.buktiPotong);
    try {
      applySettlement({ total: plan.total, settled: plan.settled + plan.pending }, amount, withheld);
    } catch (e) {
      if (e instanceof SettlementError) throw new BadRequestException(e.message);
      throw e;
    }

    const key = `payments/${tenant.id}/${invoiceId}/${randomUUID()}`;
    const { storageKey } = await this.storage.save({ key, buffer: proof.buffer, contentType: proof.mimetype });
    const bukti = net.buktiPotong
      ? await this.storage.save({ key: `payments/${tenant.id}/${invoiceId}/bukti-potong-${randomUUID()}`, buffer: net.buktiPotong.buffer, contentType: net.buktiPotong.mimetype })
      : null;

    return this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.payment.create({
        data: {
          tenantId: tenant.id,
          invoiceId,
          provider: "MANUAL",
          idempotencyKey: randomUUID(),
          method,
          status: "PENDING",
          amount: amount.toFixed(2),
          pphWithheldAmount: withheld.toFixed(2),
          buktiPotongKey: bukti?.storageKey ?? null,
          buktiPotongAt: bukti ? new Date() : null,
          recordedByUserId,
          proofUrl: storageKey,
        },
      }),
    );
  }

  private assertFile(f: { mimetype: string; size: number }) {
    if (!ALLOWED_CONTENT_TYPES.has(f.mimetype)) throw new BadRequestException(`Unsupported file type "${f.mimetype}". Use JPEG, PNG, WebP, or PDF.`);
    if (f.size > MAX_FILE_BYTES) throw new BadRequestException("File too large — max 8MB.");
  }

  /**
   * PRD go-live 2 §10.1 — where an invoice stands: total, settled by verified
   * payments, held by payments awaiting verification, outstanding, and — for a
   * withholding customer with net settlement enabled — the PPh expected.
   */
  async settlementPlan(tenantId: string, invoiceId: string) {
    const t = await this.prisma.raw.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { organization: { select: { taxConfig: true } } } });
    const taxConfig = (t.organization.taxConfig ?? {}) as { pphWithholdingEnabled?: boolean; pphRates?: Record<string, number>; defaultPphType?: string };
    const inv = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.invoice.findUnique({ where: { id: invoiceId }, include: { lines: true, customer: true, payments: { where: { status: "PENDING" } } } }),
    );
    if (!inv) throw new NotFoundException("Invoice not found.");
    const total = Number(inv.totalAmount.toString());
    const settled = Number(inv.settledAmount.toString());
    const pending = inv.payments.reduce((s, p) => s + Number(p.amount.toString()) + Number(p.pphWithheldAmount.toString()), 0);
    const pphEnabled = taxConfig.pphWithholdingEnabled === true;
    // DPP: the rent and other charges — never the deposit, never the PPN (same base as the invoice PDF).
    const dpp = inv.lines.filter((l) => l.lineType !== "DEPOSIT" && l.lineType !== "TAX").reduce((s, l) => s + Number(l.amount.toString()), 0);
    const expected =
      pphEnabled && inv.customer.pphWithheld === true
        ? expectedPphWithholding(dpp, (inv.customer.pphType ?? taxConfig.defaultPphType ?? null) as PphType | null, taxConfig.pphRates)
        : null;
    return { total, settled, pending, outstanding: Math.max(0, total - settled), pphEnabled, customerWithholds: inv.customer.pphWithheld === true, expected };
  }

  /** PRD go-live 2 §10.1 — attach the bukti potong to a payment after the fact. */
  async attachBuktiPotong(tenant: ResolvedTenant, paymentId: string, file: { buffer: Buffer; mimetype: string; size: number }) {
    this.assertFile(file);
    const payment = await this.prisma.runInTenantContext(tenant.id, (tx) => tx.payment.findUnique({ where: { id: paymentId } }));
    if (!payment) throw new NotFoundException("Payment not found.");
    if (Number(payment.pphWithheldAmount.toString()) <= 0) throw new BadRequestException("This payment has no PPh withheld, so it needs no bukti potong.");
    const { storageKey } = await this.storage.save({ key: `payments/${tenant.id}/${payment.invoiceId}/bukti-potong-${randomUUID()}`, buffer: file.buffer, contentType: file.mimetype });
    return this.prisma.runInTenantContext(tenant.id, (tx) => tx.payment.update({ where: { id: paymentId }, data: { buktiPotongKey: storageKey, buktiPotongAt: new Date() } }));
  }

  /** "Bukti potong belum diterima" — payments with PPh withheld and no slip yet. */
  async buktiPotongOutstanding(tenant: ResolvedTenant) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const rows = await tx.payment.findMany({
        where: { pphWithheldAmount: { gt: 0 }, buktiPotongKey: null, status: { in: ["PENDING", "SUCCEEDED"] } },
        orderBy: { createdAt: "asc" },
        include: { invoice: { select: { id: true, invoiceNumber: true, totalAmount: true, customer: { select: { id: true, customerNumber: true, fullName: true, companyName: true } } } } },
      });
      return rows.map((p) => ({
        paymentId: p.id,
        status: p.status,
        paidAt: p.paidAt,
        createdAt: p.createdAt,
        amount: p.amount.toString(),
        pphWithheldAmount: p.pphWithheldAmount.toString(),
        invoice: { id: p.invoice.id, invoiceNumber: p.invoice.invoiceNumber, totalAmount: p.invoice.totalAmount.toString() },
        customer: p.invoice.customer,
      }));
    });
  }

  /** Staff open the bukti potong file. */
  async getBuktiPotongFile(tenant: ResolvedTenant, paymentId: string) {
    const payment = await this.prisma.runInTenantContext(tenant.id, (tx) => tx.payment.findUnique({ where: { id: paymentId } }));
    if (!payment?.buktiPotongKey) throw new NotFoundException("This payment has no bukti potong.");
    return this.storage.read(payment.buktiPotongKey);
  }

  /** Staff-only proof-of-payment preview — same redirect/buffer shape as KYC/contract file reads. */
  async getProofFile(tenant: ResolvedTenant, paymentId: string) {
    const payment = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.payment.findUnique({ where: { id: paymentId } }),
    );
    if (!payment) throw new NotFoundException("Payment not found.");
    if (!payment.proofUrl) throw new NotFoundException("This payment has no proof-of-payment file.");
    return this.storage.read(payment.proofUrl);
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

    // PRD go-live 2 §10.1 — a payment may settle part of the invoice (short, or net of PPh).
    const amount = Number(payment.amount.toString());
    const withheld = Number(payment.pphWithheldAmount.toString());
    const outcome = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: payment.invoiceId }, include: { lines: true } });
      if (inv.status !== "ISSUED" && inv.status !== "OVERDUE") throw new ConflictException(`Invoice is ${inv.status}; this payment can no longer be applied.`);
      let result;
      try {
        result = applySettlement({ total: Number(inv.totalAmount.toString()), settled: Number(inv.settledAmount.toString()) }, amount, withheld);
      } catch (e) {
        if (e instanceof SettlementError) throw new BadRequestException(e.message);
        throw e;
      }
      await tx.payment.update({ where: { id: paymentId }, data: { status: "SUCCEEDED", verifiedByUserId, paidAt: new Date() } });
      if (!result.paidInFull) {
        // Open balance: post this payment's share now; the invoice stays ISSUED/OVERDUE.
        const ledger = settlementLedger({ amount, withheld, closing: false, depositShare: 0 });
        await recordSettlementEntries(tx, tenant.id, paymentId, inv.invoiceNumber, ledger);
        await tx.invoice.update({ where: { id: inv.id }, data: { settledAmount: result.settledAfter.toFixed(2) } });
      }
      return result;
    });
    if (!outcome.paidInFull) return { status: "verified", paidInFull: false, outstanding: outcome.outstandingAfter };
    await this.finalizePaidInvoice(tenant, payment.invoiceId, payment.id);
    return { status: "verified", paidInFull: true, outstanding: 0 };
  }

  private async finalizePaidInvoice(tenant: ResolvedTenant, invoiceId: string, paymentId: string) {
    const { bookingId, hasDeposit, depositAmount, invoiceNumber, totalAmount, paymentAmount, customer } =
      await this.prisma.runInTenantContext(tenant.id, async (tx) => {
        await this.finance.markPaid(tx, invoiceId);
        const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true, customer: true } });
        const depositLine = invoice.lines.find((l) => l.lineType === "DEPOSIT");
        const depositAmt = depositLine?.amount.toString();
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });

        // The AR closed here excludes the deposit — it was never in AR/Revenue
        // (see packages/database/src/ledger.ts); its cash is posted by the
        // deposit entries. PRD go-live 2 §10.1: the closing payment may be net
        // of PPh and may follow earlier partial payments, so the amounts come
        // from settlementLedger. A full single payment posts exactly what it
        // always did (cash = AR = total − deposit).
        let ledger;
        try {
          ledger = settlementLedger({
            amount: Number(payment.amount.toString()),
            withheld: Number(payment.pphWithheldAmount.toString()),
            closing: true,
            depositShare: Number(depositAmt ?? 0),
          });
        } catch (e) {
          if (e instanceof SettlementError) throw new BadRequestException(e.message);
          throw e;
        }
        await recordSettlementEntries(tx, tenant.id, paymentId, invoice.invoiceNumber, ledger);

        return {
          bookingId: invoice.bookingId,
          hasDeposit: Boolean(depositLine),
          depositAmount: depositAmt,
          invoiceNumber: invoice.invoiceNumber,
          totalAmount: invoice.totalAmount.toString(),
          paymentAmount: payment.amount.toString(),
          customer: invoice.customer,
        };
      });

    // PRD §8.4 A4: "Match invoice -> transition states -> receipt via WA" — the receipt half.
    await this.notifications.notifyCustomer({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      customer,
      templateKey: "invoice_paid",
      variables: { invoiceNumber, totalAmount },
      link: { purpose: "INVOICE", next: `/portal/invoices/${invoiceId}` },
    });

    await this.webhooks.dispatch(tenant, "invoice.paid", { invoiceId, invoiceNumber, totalAmount, bookingId });
    await this.webhooks.dispatch(tenant, "payment.received", {
      paymentId,
      invoiceId,
      amount: paymentAmount,
    });

    if (bookingId) {
      await this.booking.handleInvoicePaid(tenant, bookingId, hasDeposit, depositAmount);
    }
  }
}
