import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@rentos/database";
import { classifyCustomerHealth, money, roundMoney, type CustomerHealth } from "@rentos/domain";
import type { ClientListItem, ClientListQuery, ClientListResponse } from "@rentos/contracts";

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

@Injectable()
export class CrmService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreateByPhone(tenantId: string, phone: string, fullName?: string) {
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
        // A name given at booking time fills a blank profile but never overwrites one.
        if (!existing.fullName && fullName) {
          return tx.customer.update({ where: { id: existing.id }, data: { fullName } });
        }
        return existing;
      }

      // New customer — record the canonical phone also as a verified CustomerPhone
      // (the number they just OTP-verified to log in), so future add-number logic
      // has a consistent set to work against.
      const customer = await tx.customer.create({ data: { tenantId, phone, fullName } });
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
  async fillProfile(tenantId: string, customerId: string, details: { phone?: string; fullName?: string }) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const existing = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
      this.assertNotBlocklisted(existing);
      const data: Prisma.CustomerUpdateInput = {};
      if (!existing.phone && details.phone) {
        const taken = await tx.customer.findUnique({ where: { tenantId_phone: { tenantId, phone: details.phone } } });
        if (!taken) data.phone = details.phone;
      }
      if (!existing.fullName && details.fullName) data.fullName = details.fullName;
      return Object.keys(data).length ? tx.customer.update({ where: { id: customerId }, data }) : existing;
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
