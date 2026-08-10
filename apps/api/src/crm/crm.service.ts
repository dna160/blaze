import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service.js";

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
        if (existing.isBlocklisted) {
          throw new ForbiddenException("This customer account cannot book at this time.");
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
}
