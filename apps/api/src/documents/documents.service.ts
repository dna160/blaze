import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { computeDeposit, computeTax, money, parseContractTerms, roundMoney, type DepositRule, type ParsedContractTerms } from "@rentos/domain";

import { onlinePaymentsStatus } from "../payments/online-payments.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { STORAGE_PROVIDER, type StorageProvider } from "../storage/storage-provider.interface.js";

import {
  renderContractPdf,
  renderInvoicePdf,
  type BankAccountLine,
  type BranchBlock,
  type CustomerBlock,
  type DocLine,
} from "./pdf-layout.js";

/**
 * PRD v2 P9 / go-live §7 — contracts and invoices as City Storage's own
 * documents. This service assembles everything a document shows from the
 * database (branch profile, customer, unit, numbers, terms version,
 * signature) and hands it to the pure layout in pdf-layout.ts; PDFs are
 * stored through the StorageProvider port exactly like KYC uploads (local
 * disk in dev, S3 in production).
 *
 * A contract always re-renders with the T&C version stored on it, so a
 * signed contract keeps the terms that were signed even after the
 * organization publishes a new version.
 */

const RATE_LABEL: Record<string, string> = { MONTHLY: "Monthly", WEEKLY: "Weekly", DAILY: "Daily" };

interface PriceSnapshot {
  basePrice?: number;
  currency?: string;
  depositRule?: DepositRule;
  taxInclusive?: boolean;
}

function asStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v.trim()) return [v];
  return [];
}

function sum(values: Array<{ toString(): string }>): number {
  return values.reduce<number>((a, v) => a + Number(v.toString()), 0);
}

function money2(n: number): string {
  return roundMoney(money(n)).toFixed(2);
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  // ---------------------------------------------------------------- shared

  /** `tenants`/`organizations`/`contract_terms` sit outside RLS — plain reads. */
  private async branch(tenantId: string) {
    const t = await this.prisma.raw.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      include: { organization: { select: { id: true, legalName: true, taxConfig: true } }, domains: { where: { isPrimary: true } } },
    });
    const contact = (t.contact ?? {}) as { whatsapp?: string; whatsappDisplay?: string; phone?: string; email?: string };
    const branding = (t.branding ?? {}) as { logoPngBase64?: string };
    const banks = ((t.bankAccounts ?? []) as unknown as Array<BankAccountLine & { showOnInvoice?: boolean }>).filter((b) => b.showOnInvoice !== false);
    const block: BranchBlock = {
      name: t.name,
      legalName: t.legalName ?? t.organization.legalName,
      addressLines: asStrings(t.address),
      phone: contact.phone ?? null,
      whatsapp: contact.whatsappDisplay ?? contact.whatsapp ?? null,
      email: contact.email ?? null,
      logoPng: branding.logoPngBase64 ? Buffer.from(branding.logoPngBase64, "base64") : null,
      bankAccounts: banks,
    };
    const domain = t.domains[0]?.domain;
    const storefront =
      domain && !/\.(local|test|localhost)$/.test(domain) ? `https://${domain}` : (process.env.STOREFRONT_BASE_URL ?? "http://localhost:3000").replace("{tenant}", t.slug);
    return {
      block,
      isPkp: t.isPkp,
      organizationId: t.organization.id,
      taxConfig: (t.organization.taxConfig ?? {}) as { pphWithholdingEnabled?: boolean; pphRates?: Record<string, number>; defaultPphType?: string },
      featureFlags: (t.featureFlags ?? {}) as Record<string, unknown>,
      storefront,
    };
  }

  private customerBlock(c: {
    type: string;
    fullName: string | null;
    companyName: string | null;
    address: string | null;
    email: string | null;
    phone: string | null;
    taxId: string | null;
    customerNumber: number | null;
  }): CustomerBlock {
    return {
      name: c.fullName ?? c.companyName ?? "-",
      companyName: c.companyName,
      address: c.address,
      email: c.email,
      phone: c.phone,
      taxId: c.taxId,
      isBusiness: c.type === "BUSINESS",
      customerNumber: c.customerNumber,
    };
  }

  /** Raw bytes of a stored object, whichever provider holds it (S3 hands back a presigned URL). */
  async readBytes(storageKey: string): Promise<Buffer | null> {
    const r = await this.storage.read(storageKey);
    if (r.kind === "buffer") return r.buffer;
    const res = await fetch(r.url);
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  }

  private async terms(organizationId: string, version: number | null): Promise<{ parsed: ParsedContractTerms | null; version: number | null }> {
    const row = version
      ? await this.prisma.raw.contractTerms.findUnique({ where: { organizationId_version: { organizationId, version } } })
      : await this.prisma.raw.contractTerms.findFirst({ where: { organizationId }, orderBy: { version: "desc" } });
    return row ? { parsed: parseContractTerms(row.body), version: row.version } : { parsed: null, version: null };
  }

  // -------------------------------------------------------------- contract

  async contractPdf(tenantId: string, contractId: string, opts: { withSignature: boolean }): Promise<Buffer> {
    const contract = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.contract.findUnique({
        where: { id: contractId },
        include: {
          booking: { include: { customer: true, asset: true, assetType: true, invoices: { include: { lines: true } }, deposits: true } },
          rentalOrder: { include: { customer: true, asset: true, assetType: true, invoices: { include: { lines: true } } } },
        },
      }),
    );
    if (!contract) throw new NotFoundException("Contract not found.");
    const owner = contract.booking ?? contract.rentalOrder;
    if (!owner) throw new NotFoundException("Contract has neither a booking nor a rental order.");

    const branch = await this.branch(tenantId);
    const snapshot = ((contract.booking?.priceSnapshot ?? contract.rentalOrder?.priceSnapshot) ?? {}) as PriceSnapshot;
    const currency = snapshot.currency ?? "IDR";
    const base = money(snapshot.basePrice ?? 0);
    const invoices = [...owner.invoices].filter((i) => i.status !== "VOID").sort((a, b) => (a.scheduleIndex ?? 0) - (b.scheduleIndex ?? 0));
    const proforma = invoices.find((i) => i.scheduleIndex === 0) ?? invoices[0];
    // PKP as it was when the contract was billed, not as it is today (§8.1).
    const pkp = proforma ? Number(proforma.taxAmount.toString()) > 0 : branch.isPkp;
    const tax = computeTax(base, { isTenantPkp: pkp, taxInclusive: snapshot.taxInclusive ?? false });
    const heldDeposit = contract.booking?.deposits[0]?.amount;
    const depositLine = proforma?.lines.find((l) => l.lineType === "DEPOSIT")?.amount;
    const deposit = heldDeposit ?? depositLine ?? computeDeposit(snapshot.depositRule, base);

    const rate = contract.booking?.rateTier ?? "MONTHLY";
    const lines: DocLine[] = [
      {
        title: `1x ${owner.assetType.name}`,
        period: RATE_LABEL[rate] ?? rate,
        subLine: `Storage — ${owner.asset?.code ?? "(unit to be assigned)"}`,
        amount: tax.netAmount.toFixed(2),
      },
    ];

    const terms = await this.terms(branch.organizationId, contract.termsVersion);
    const signaturePng = opts.withSignature && contract.signatureImageKey ? await this.readBytes(contract.signatureImageKey) : null;

    return renderContractPdf({
      branch: branch.block,
      customer: this.customerBlock(owner.customer),
      contractNumber: contract.contractNumber ?? contract.id.slice(0, 8).toUpperCase(),
      date: contract.createdAt,
      bookingRef: contract.booking?.legacyBookingNumber ?? owner.id.slice(0, 8).toUpperCase(),
      from: contract.booking?.startDate ?? contract.rentalOrder!.periodStart,
      // The last billed day (inclusive), as on the payment schedule — Booking.endDate is exclusive.
      until: invoices.filter((i) => i.periodEnd).at(-1)?.periodEnd ?? contract.booking?.endDate ?? contract.rentalOrder?.periodEnd ?? null,
      lines,
      totals: {
        currency,
        subtotal: tax.netAmount.toFixed(2),
        taxAmount: pkp ? tax.taxAmount.toFixed(2) : null,
        total: tax.grossAmount.toFixed(2),
        deposit: Number(deposit.toString()) > 0 ? deposit.toString() : null,
        due: null,
      },
      schedule: invoices
        .filter((i) => i.scheduleIndex !== null && i.periodStart && i.periodEnd)
        .map((i) => ({
          index: i.scheduleIndex!,
          periodStart: i.periodStart!,
          periodEnd: i.periodEnd!,
          dueDate: i.dueDate,
          amount: i.totalAmount.toString(),
          invoiceNumber: i.invoiceNumber,
        })),
      terms: terms.parsed,
      termsVersion: terms.version,
      signature:
        opts.withSignature && contract.signedAt
          ? { png: signaturePng, signerName: contract.signedByName ?? owner.customer.fullName ?? "", signedAt: contract.signedAt }
          : null,
      confirmedAt: opts.withSignature ? contract.confirmedAt : null,
    });
  }

  /**
   * Render and store the generated (unsigned) agreement, and — once it was
   * signed on the signature pad — the signed version with the signature and
   * any CONFIRMED stamp. A contract signed by uploading a scan keeps that
   * scan as its signed document; only the generated copy is refreshed.
   */
  async regenerateContract(tenantId: string, contractId: string): Promise<{ unsignedKey: string; signedKey: string | null }> {
    const contract = await this.prisma.runInTenantContext(tenantId, (tx) => tx.contract.findUniqueOrThrow({ where: { id: contractId } }));
    const folder = `contracts/${tenantId}/${contract.bookingId ?? contract.rentalOrderId}`;
    const unsignedKey = await this.store(`${folder}/agreement-${contractId}.pdf`, await this.contractPdf(tenantId, contractId, { withSignature: false }));
    let signedKey: string | null = null;
    if (contract.signatureImageKey) {
      signedKey = await this.store(
        `${folder}/agreement-${contractId}-signed${contract.confirmedAt ? "-confirmed" : ""}.pdf`,
        await this.contractPdf(tenantId, contractId, { withSignature: true }),
      );
    }
    await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.contract.update({ where: { id: contractId }, data: { unsignedDocumentUrl: unsignedKey, ...(signedKey ? { documentUrl: signedKey } : {}) } }),
    );
    return { unsignedKey, signedKey };
  }

  // --------------------------------------------------------------- invoice

  async invoicePdf(tenantId: string, invoiceId: string): Promise<Buffer> {
    const invoice = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.invoice.findUnique({
        where: { id: invoiceId },
        include: {
          lines: true,
          customer: true,
          booking: { include: { asset: true, contracts: { orderBy: { createdAt: "desc" }, take: 1 } } },
          rentalOrder: { include: { asset: true, contracts: { orderBy: { createdAt: "desc" }, take: 1 } } },
        },
      }),
    );
    if (!invoice) throw new NotFoundException("Invoice not found.");
    const branch = await this.branch(tenantId);
    const owner = invoice.booking ?? invoice.rentalOrder;
    const unitCode = owner?.asset?.code ?? null;

    const chargeLines = invoice.lines.filter((l) => l.lineType !== "DEPOSIT" && l.lineType !== "TAX");
    const depositLines = invoice.lines.filter((l) => l.lineType === "DEPOSIT");
    const subtotal = sum(chargeLines.map((l) => l.amount));
    const taxAmount = Number(invoice.taxAmount.toString());
    const deposit = sum(depositLines.map((l) => l.amount));
    const due = Number(invoice.totalAmount.toString());

    const lines: DocLine[] = chargeLines.map((l) => ({
      title: Number(l.quantity.toString()) !== 1 ? `${Number(l.quantity.toString())}x ${l.description}` : l.description,
      period: l.lineType === "RENT" ? "Monthly" : "",
      subLine: l.lineType === "RENT" && unitCode ? `Storage — ${unitCode}` : null,
      amount: l.amount.toString(),
    }));

    // §8.3 — display only, and only once finance has validated the rates
    // (Organization.taxConfig.pphWithholdingEnabled). DPP is the rent, never
    // the deposit or the PPN.
    let withholding: { label: string; amount: string; transfer: string } | null = null;
    if (invoice.customer.pphWithheld === true && branch.taxConfig.pphWithholdingEnabled === true) {
      const type = invoice.customer.pphType ?? branch.taxConfig.defaultPphType ?? "PPH_4_2_FINAL";
      const rate = branch.taxConfig.pphRates?.[type] ?? (type === "PPH_23" ? 0.02 : 0.1);
      const amount = Math.round(subtotal * rate);
      withholding = {
        label: `${type === "PPH_23" ? "PPh 23" : "PPh Final 4(2)"} ${Math.round(rate * 1000) / 10}% dipotong oleh penyewa`,
        amount: money2(amount),
        transfer: money2(due - amount),
      };
    }

    const online = onlinePaymentsStatus(branch.featureFlags).enabled;
    return renderInvoicePdf({
      branch: branch.block,
      customer: this.customerBlock(invoice.customer),
      kind: invoice.scheduleIndex === 0 && invoice.status !== "PAID" ? "PROFORMA" : "INVOICE",
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      bookingRef: invoice.booking ? (invoice.booking.legacyBookingNumber ?? invoice.booking.id.slice(0, 8).toUpperCase()) : null,
      contractNumber: owner?.contracts[0]?.contractNumber ?? null,
      from: invoice.periodStart,
      until: invoice.periodEnd,
      lines,
      totals: {
        currency: invoice.currency,
        subtotal: money2(subtotal),
        taxAmount: taxAmount > 0 ? money2(taxAmount) : null,
        total: money2(subtotal + taxAmount),
        deposit: deposit > 0 ? money2(deposit) : null,
        due: money2(due),
      },
      withholding,
      portalUrl: online ? `${branch.storefront}/portal/invoices/${invoice.id}` : null,
    });
  }

  // --------------------------------------------------------------- storage

  async store(key: string, buffer: Buffer, contentType = "application/pdf"): Promise<string> {
    const { storageKey } = await this.storage.save({ key, buffer, contentType });
    return storageKey;
  }

  read(storageKey: string) {
    return this.storage.read(storageKey);
  }
}
