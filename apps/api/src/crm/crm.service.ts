import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@rentos/database";
import { classifyCustomerHealth, money, roundMoney, type CustomerHealth } from "@rentos/domain";
import type { ClientListItem, ClientListQuery, ClientListResponse } from "@rentos/contracts";
import { isKycVerified } from "@rentos/contracts";

import { AuditService } from "../audit/audit.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

/** Bookings that count as "still with us" for the client list (PRD v2 §5.2 — INACTIVE means none of these). Ended leases (MOVED_OUT/CLOSED) are not live even though they still hold their blackout window. */
const LIVE_BOOKING_STATUSES = [
  "WAITLISTED",
  "PENDING_APPROVAL",
  "NEEDS_INFO",
  "APPROVED",
  "ACTIVE",
  "RENEWING",
  "SUSPENDED",
  "NOTICE_GIVEN",
  "DEFAULT",
] as const;

/** The individual/company choice a booking carries, and the company name with it. */
export interface BusinessDetails {
  type?: "INDIVIDUAL" | "BUSINESS";
  companyName?: string;
}

@Injectable()
export class CrmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Resolve a customer by phone WITHOUT creating one. Same resolution as
   * getOrCreateByPhone — canonical number, or a VERIFIED additional number —
   * for callers that must not bring an account into existence.
   *
   * Sign-in is the case that needs this: the request is unauthenticated and
   * keyed only on a phone number, so creating on lookup would let anyone fill
   * the table with accounts by posting numbers at it. Accounts are created by
   * booking, or by proving control of the number, not by asking to log in.
   */
  async findByPhone(tenantId: string, phone: string) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const byCanonical = await tx.customer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
      if (byCanonical) return byCanonical;
      const additional = await tx.customerPhone
        .findUnique({ where: { tenantId_phone: { tenantId, phone } }, include: { customer: true } });
      return additional?.verifiedAt ? additional.customer : null;
    });
  }

  async getOrCreateByPhone(tenantId: string, phone: string, fullName?: string, business?: BusinessDetails) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      // #3 — a business account maps multiple WhatsApp numbers to one Customer.
      // Resolve by the canonical phone OR any VERIFIED additional number first.
      const existing =
        (await tx.customer.findUnique({ where: { tenantId_phone: { tenantId, phone } } })) ??
        (await tx.customerPhone
          .findUnique({ where: { tenantId_phone: { tenantId, phone } }, include: { customer: true } })
          .then((cp) => (cp && cp.verifiedAt ? cp.customer : null)));

      if (existing) {
        this.assertNotBlocklisted(existing);
        const data: Prisma.CustomerUpdateInput = {};
        // A name given at booking time fills a blank profile but never overwrites one.
        if (!existing.fullName && fullName) data.fullName = fullName;
        Object.assign(data, this.businessUpgrade(existing, business));
        return Object.keys(data).length ? tx.customer.update({ where: { id: existing.id }, data }) : existing;
      }

      // New customer — record the canonical phone also as a verified CustomerPhone
      // (the number they just OTP-verified to log in), so future add-number logic
      // has a consistent set to work against.
      const customer = await tx.customer.create({
        data: {
          tenantId,
          phone,
          fullName,
          type: business?.type ?? "INDIVIDUAL",
          companyName: business?.type === "BUSINESS" ? (business.companyName ?? null) : null,
        },
      });
      await tx.customerPhone.create({
        data: { tenantId, customerId: customer.id, phone, isPrimary: true, verifiedAt: new Date() },
      });
      return customer;
    });
  }

  /** #3 — list the WhatsApp numbers attached to a (business) customer account. */
  listPhones(tenantId: string, customerId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.customerPhone.findMany({ where: { customerId }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] }),
    );
  }

  /**
   * #3 — attach an additional WhatsApp number to a customer. Created UNVERIFIED;
   * an OTP round-trip (auth flow) confirms it via confirmPhone before it can act
   * on the account (getOrCreateByPhone only resolves VERIFIED numbers).
   */
  async addPhone(tenantId: string, customerId: string, phone: string) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      // Clash check must cover BOTH the additional-numbers table AND the canonical
      // Customer.phone — a legacy customer (created before CustomerPhone existed)
      // has a login phone but no CustomerPhone row, and that number must not be
      // attachable to a different account.
      const [phoneClash, canonicalClash] = await Promise.all([
        tx.customerPhone.findUnique({ where: { tenantId_phone: { tenantId, phone } } }),
        tx.customer.findUnique({ where: { tenantId_phone: { tenantId, phone } } }),
      ]);
      if (phoneClash || (canonicalClash && canonicalClash.id !== customerId)) {
        throw new ForbiddenException("That number is already attached to an account.");
      }
      return tx.customerPhone.create({ data: { tenantId, customerId, phone, isPrimary: false } });
    });
  }

  /** #3 — mark an added number verified after its OTP confirmation succeeds. */
  async confirmPhone(tenantId: string, customerId: string, phone: string) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const cp = await tx.customerPhone.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
      if (!cp || cp.customerId !== customerId) throw new NotFoundException("Number not found on this account.");
      return tx.customerPhone.update({ where: { id: cp.id }, data: { verifiedAt: new Date() } });
    });
  }

  /**
   * PRD v2 D3 — Google (Clerk) sign-in keys the customer by email. The
   * Clerk user id is stored so a later sign-in with the same Google account
   * resolves even if the email on file is edited. Such customers get EMAIL
   * as their preferred channel; a pre-existing WhatsApp customer who later
   * signs in with Google on the same email keeps their row and switches
   * channel, matching the owner's "email replaces WhatsApp for Google users".
   */
  async getOrCreateByClerkIdentity(tenantId: string, identity: { clerkUserId: string; email: string; fullName?: string; phone?: string }) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const byClerk = await tx.customer.findUnique({ where: { tenantId_clerkUserId: { tenantId, clerkUserId: identity.clerkUserId } } });
      const byEmail = byClerk ?? (await tx.customer.findUnique({ where: { tenantId_email: { tenantId, email: identity.email } } }));
      if (byEmail) {
        this.assertNotBlocklisted(byEmail);
        return tx.customer.update({
          where: { id: byEmail.id },
          data: {
            clerkUserId: identity.clerkUserId,
            email: identity.email,
            preferredChannel: "EMAIL",
            fullName: byEmail.fullName ?? identity.fullName,
            phone: byEmail.phone ?? identity.phone,
          },
        });
      }
      return tx.customer.create({
        data: {
          tenantId,
          clerkUserId: identity.clerkUserId,
          email: identity.email,
          fullName: identity.fullName,
          phone: identity.phone,
          preferredChannel: "EMAIL",
        },
      });
    });
  }

  /** Booking-time details from a logged-in customer: fill a missing phone/name, never overwrite. */
  async fillProfile(
    tenantId: string,
    customerId: string,
    details: { phone?: string; fullName?: string; business?: BusinessDetails },
  ) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const existing = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
      this.assertNotBlocklisted(existing);
      const data: Prisma.CustomerUpdateInput = {};
      if (!existing.phone && details.phone) {
        const taken = await tx.customer.findUnique({ where: { tenantId_phone: { tenantId, phone: details.phone } } });
        if (!taken) data.phone = details.phone;
      }
      if (!existing.fullName && details.fullName) data.fullName = details.fullName;
      Object.assign(data, this.businessUpgrade(existing, details.business));
      return Object.keys(data).length ? tx.customer.update({ where: { id: customerId }, data }) : existing;
    });
  }

  /**
   * What a booking may change about an existing customer's type.
   *
   * INDIVIDUAL to BUSINESS, never the reverse. Someone who has already given us
   * a NIB and an NPWP should not have that bar quietly lowered because they
   * made one booking in a personal capacity — and relaxing a KYC requirement is
   * the direction where a mistake costs something. Going the other way is a
   * staff decision, not a side effect of a form.
   *
   * The upgrade also reopens verification. A customer verified as an individual
   * has not shown us a NIB or an NPWP, so leaving them VERIFIED would report a
   * company as fully checked on the strength of a KTP alone. Their next upload
   * recomputes it properly; this just stops the stale VERIFIED standing.
   */
  private businessUpgrade(
    existing: { type: "INDIVIDUAL" | "BUSINESS"; companyName: string | null; kycStatus: string },
    business?: BusinessDetails,
  ): Prisma.CustomerUpdateInput {
    if (business?.type !== "BUSINESS") return {};

    const data: Prisma.CustomerUpdateInput = {};
    if (existing.type !== "BUSINESS") {
      data.type = "BUSINESS";
      if (isKycVerified(existing.kycStatus)) data.kycStatus = "PENDING_REVIEW";
    }
    // Fills a blank company name; never overwrites one already on file.
    if (!existing.companyName && business.companyName) data.companyName = business.companyName;
    return data;
  }

  /**
   * The customer's answer to "Apakah dibebankan PPh?", plus the NPWP and NIB
   * numbers if they typed them. Set from the portal, by the customer, about
   * themselves — so no capability check beyond owning the session.
   *
   * Does not touch kycStatus: the answer is a tax fact, not a document, and an
   * optional PPh slip must never be what holds verification open.
   */
  async setTaxProfile(
    tenantId: string,
    customerId: string,
    input: { pphWithheld: boolean; taxId?: string; nib?: string },
  ) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const existing = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
      this.assertNotBlocklisted(existing);
      return tx.customer.update({
        where: { id: customerId },
        data: {
          pphWithheld: input.pphWithheld,
          ...(input.taxId?.trim() ? { taxId: input.taxId.trim() } : {}),
          ...(input.nib?.trim() ? { nib: input.nib.trim() } : {}),
        },
      });
    });
  }

  /**
   * PRD go-live §8.2 — staff set or correct the PPh answer (and the PPh type)
   * on the client page. Audited, since it changes what the customer transfers.
   */
  async setTaxProfileByStaff(
    tenantId: string,
    customerId: string,
    actorUserId: string,
    input: { pphWithheld?: boolean | null; pphType?: "PPH_4_2_FINAL" | "PPH_23" | null; taxId?: string | null; address?: string | null },
  ) {
    const { before, after } = await this.prisma.runInTenantContext(tenantId, async (tx) => {
      const before = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
      const after = await tx.customer.update({
        where: { id: customerId },
        data: {
          ...(input.pphWithheld !== undefined ? { pphWithheld: input.pphWithheld } : {}),
          ...(input.pphType !== undefined ? { pphType: input.pphType } : {}),
          ...(input.taxId !== undefined ? { taxId: input.taxId?.trim() || null } : {}),
          ...(input.address !== undefined ? { address: input.address?.trim() || null } : {}),
        },
      });
      return { before, after };
    });
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of ["pphWithheld", "pphType", "taxId", "address"] as const) {
      if (before[k] !== after[k]) changes[k] = { from: before[k], to: after[k] };
    }
    if (Object.keys(changes).length) {
      await this.audit.record({ tenantId, actorUserId, action: "CUSTOMER_TAX_PROFILE_UPDATED", entityType: "Customer", entityId: customerId, metadata: { changes } });
    }
    return after;
  }

  /**
   * PRD go-live §7.4 — every document on file for a client, newest first,
   * each with the URL the console opens in a new tab. KYC files are listed
   * only for roles that may review KYC; contracts, invoices and payment
   * proofs for any staff role in scope (the RLS tenant context is the scope).
   */
  async listDocuments(tenantId: string, customerId: string, opts: { includeKyc: boolean }) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } });
      if (!customer) throw new NotFoundException("Customer not found.");
      const [contracts, invoices, payments, kyc] = await Promise.all([
        tx.contract.findMany({
          where: { OR: [{ booking: { customerId } }, { rentalOrder: { customerId } }] },
          orderBy: { createdAt: "desc" },
          include: { booking: { select: { asset: { select: { code: true } } } }, rentalOrder: { select: { asset: { select: { code: true } } } } },
        }),
        tx.invoice.findMany({ where: { customerId, status: { not: "SCHEDULED" } }, orderBy: { issueDate: "desc" } }),
        tx.payment.findMany({ where: { invoice: { customerId }, proofUrl: { not: null } }, orderBy: { createdAt: "desc" }, include: { invoice: { select: { invoiceNumber: true } } } }),
        opts.includeKyc ? tx.kycDocument.findMany({ where: { customerId }, orderBy: { createdAt: "desc" } }) : Promise.resolve([]),
      ]);
      type Doc = { kind: string; label: string; detail: string | null; status: string | null; date: string; href: string };
      const docs: Doc[] = [];
      for (const c of contracts) {
        const unit = c.booking?.asset?.code ?? c.rentalOrder?.asset?.code ?? null;
        const num = c.contractNumber ?? c.id.slice(0, 8).toUpperCase();
        if (c.unsignedDocumentUrl) {
          docs.push({ kind: "CONTRACT", label: `Contract #${num}`, detail: unit, status: "GENERATED", date: c.createdAt.toISOString(), href: `/contracts/${c.id}/document` });
        }
        if (c.documentUrl) {
          docs.push({
            kind: "SIGNED_CONTRACT",
            label: `Signed contract #${num}`,
            detail: [unit, c.signedByName, c.esignProvider].filter(Boolean).join(" · ") || null,
            status: c.confirmedAt ? "CONFIRMED" : (c.esignStatus ?? null),
            date: (c.signedAt ?? c.createdAt).toISOString(),
            href: `/contracts/${c.id}/file`,
          });
        }
      }
      for (const i of invoices) {
        docs.push({ kind: "INVOICE", label: `Invoice #${i.invoiceNumber}`, detail: i.totalAmount.toString(), status: i.status, date: i.issueDate.toISOString(), href: `/invoices/${i.id}/pdf` });
      }
      for (const p of payments) {
        docs.push({ kind: "PAYMENT_PROOF", label: `Payment proof — Invoice #${p.invoice.invoiceNumber}`, detail: p.amount.toString(), status: p.status, date: p.createdAt.toISOString(), href: `/payments/${p.id}/file` });
      }
      for (const k of kyc) {
        docs.push({ kind: "KYC", label: `KYC — ${k.documentType}`, detail: k.verificationSource, status: k.status, date: k.createdAt.toISOString(), href: `/kyc/documents/${k.id}/file` });
      }
      return docs.sort((a, b) => b.date.localeCompare(a.date));
    });
  }

  private assertNotBlocklisted(customer: { isBlocklisted: boolean }) {
    if (customer.isBlocklisted) throw new ForbiddenException("This customer account cannot book at this time.");
  }

  async getById(tenantId: string, customerId: string) {
    const customer = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.customer.findUnique({ where: { id: customerId } }),
    );
    if (!customer) throw new NotFoundException("Customer not found.");
    return customer;
  }

  listCustomers(tenantId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) => tx.customer.findMany({ orderBy: { createdAt: "desc" } }));
  }

  setBlocklist(tenantId: string, customerId: string, isBlocklisted: boolean, reason?: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.customer.update({ where: { id: customerId }, data: { isBlocklisted, blocklistReason: reason ?? null } }),
    );
  }

  /**
   * Client list (PRD v2 §5.2): every customer with their current unit(s),
   * move-in date, and a health status computed by the domain rule. One
   * query per page of customers plus their live bookings and unpaid
   * invoices — status/search filtering happens in memory because "health"
   * is derived, not stored (deriving it keeps it always-correct as due
   * dates pass, at the cost of not being a SQL WHERE; fine at a storage
   * operator's customer count).
   */
  async listClients(tenantId: string, query: ClientListQuery): Promise<ClientListResponse> {
    const asOf = new Date();
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const customers = await tx.customer.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          bookings: {
            where: { status: { in: [...LIVE_BOOKING_STATUSES] } },
            include: { asset: { select: { code: true } }, assetType: { select: { name: true } }, location: { select: { id: true, name: true } } },
            orderBy: { startDate: "asc" },
          },
          invoices: {
            where: { status: { in: ["ISSUED", "OVERDUE", "SCHEDULED"] } },
            select: { dueDate: true, totalAmount: true, status: true },
            orderBy: { dueDate: "asc" },
          },
        },
      });

      const items: Array<ClientListItem & { locationIds: string[] }> = customers.map((c) => {
        const unpaid = c.invoices.filter((i) => i.status !== "SCHEDULED");
        const overdue = unpaid.filter((i) => i.status === "OVERDUE" || i.dueDate.getTime() < asOf.getTime());
        const next = c.invoices[0] ?? null;
        const health = classifyCustomerHealth({
          hasLiveBooking: c.bookings.length > 0,
          overdueInvoiceCount: overdue.length,
          nextDueDate: next?.dueDate ?? null,
          asOf,
        });
        const outstanding = roundMoney(unpaid.reduce((sum, i) => sum.plus(money(i.totalAmount.toString())), money(0)));
        return {
          locationIds: c.bookings.map((b) => b.location?.id).filter((id): id is string => Boolean(id)),
          id: c.id,
          fullName: c.fullName,
          phone: c.phone,
          email: c.email,
          preferredChannel: c.preferredChannel,
          kycStatus: c.kycStatus,
          health,
          units: c.bookings.map((b) => ({
            bookingId: b.id,
            code: b.asset?.code ?? null,
            assetTypeName: b.assetType.name,
            locationName: b.location?.name ?? null,
            status: b.status,
          })),
          moveInDate: c.bookings[0]?.startDate.toISOString() ?? null,
          nextDueDate: next?.dueDate.toISOString() ?? null,
          nextDueAmount: next ? next.totalAmount.toString() : null,
          outstandingAmount: outstanding.toString(),
          overdueCount: overdue.length,
          createdAt: c.createdAt.toISOString(),
        };
      });

      const counts: Record<CustomerHealth, number> = { HEALTHY: 0, RISKY: 0, OVERDUE: 0, INACTIVE: 0 };
      for (const item of items) counts[item.health] += 1;

      const needle = query.search?.trim().toLowerCase();
      const filtered = items.filter((item) => {
        if (query.status && item.health !== query.status) return false;
        if (query.locationId && !item.locationIds.includes(query.locationId)) return false;
        if (!needle) return true;
        const haystack = [item.fullName, item.phone, item.email, ...item.units.map((u) => u.code), ...item.units.map((u) => u.locationName)]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(needle);
      });

      const start = (query.page - 1) * query.pageSize;
      const pageItems = filtered.slice(start, start + query.pageSize).map(({ locationIds: _ignored, ...item }) => item);
      return { items: pageItems, page: query.page, pageSize: query.pageSize, total: filtered.length, counts };
    });
  }

  /** Client detail drill-down (PRD v2 §5.2): everything about one customer on one screen. */
  async getClientDetail(tenantId: string, customerId: string) {
    const list = await this.listClients(tenantId, { page: 1, pageSize: 100 });
    const summary = list.items.find((i) => i.id === customerId);
    const detail = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.customer.findUnique({
        where: { id: customerId },
        include: {
          bookings: {
            include: {
              asset: { select: { id: true, code: true } },
              assetType: { select: { id: true, name: true } },
              location: { select: { id: true, name: true } },
              invoices: { orderBy: [{ scheduleIndex: "asc" }, { issueDate: "asc" }], include: { payments: true } },
              deposits: true,
              contracts: { orderBy: { createdAt: "desc" }, take: 1 },
            },
            orderBy: { createdAt: "desc" },
          },
          kycDocuments: { orderBy: { createdAt: "desc" } },
        },
      }),
    );
    if (!detail) throw new NotFoundException("Customer not found.");
    const notifications = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.notification.findMany({ where: { customerId }, orderBy: { createdAt: "desc" }, take: 50 }),
    );
    // A customer outside the first 100 rows still gets a summary — recompute for them alone.
    const health = summary ?? (await this.listClients(tenantId, { page: 1, pageSize: 100, search: detail.phone ?? detail.email ?? undefined })).items.find((i) => i.id === customerId) ?? null;
    return { customer: detail, summary: health, notifications };
  }
}
