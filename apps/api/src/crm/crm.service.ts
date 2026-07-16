import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service.js";

@Injectable()
export class CrmService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreateByPhone(tenantId: string, phone: string, fullName?: string) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const existing = await tx.customer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
      if (existing) {
        if (existing.isBlocklisted) {
          throw new ForbiddenException("This customer account cannot book at this time.");
        }
        return existing;
      }
      return tx.customer.create({ data: { tenantId, phone, fullName } });
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
