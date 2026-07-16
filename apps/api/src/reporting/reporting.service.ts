import { Injectable } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service.js";

/** P0-basic reporting only (PRD §7.2.6) — occupancy % and AR aging buckets. RevPAU/cohorts/forecast are P1. */
@Injectable()
export class ReportingService {
  constructor(private readonly prisma: PrismaService) {}

  async occupancy(tenantId: string) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const [total, occupied] = await Promise.all([
        tx.asset.count({ where: { status: { not: "RETIRED" } } }),
        tx.asset.count({ where: { status: "OCCUPIED" } }),
      ]);
      return { totalAssets: total, occupiedAssets: occupied, occupancyRate: total === 0 ? 0 : occupied / total };
    });
  }

  async arAging(tenantId: string) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const unpaid = await tx.invoice.findMany({
        where: { status: { in: ["ISSUED", "OVERDUE"] } },
        select: { totalAmount: true, dueDate: true },
      });

      const now = Date.now();
      const buckets = { current: 0, d1_30: 0, d31_60: 0, d60_plus: 0 };
      for (const inv of unpaid) {
        const daysOverdue = Math.floor((now - inv.dueDate.getTime()) / (1000 * 60 * 60 * 24));
        const amount = Number(inv.totalAmount);
        if (daysOverdue <= 0) buckets.current += amount;
        else if (daysOverdue <= 30) buckets.d1_30 += amount;
        else if (daysOverdue <= 60) buckets.d31_60 += amount;
        else buckets.d60_plus += amount;
      }
      return buckets;
    });
  }

  async bookingFunnel(tenantId: string) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const [requested, approved, active] = await Promise.all([
        tx.booking.count(),
        tx.booking.count({ where: { status: { in: ["APPROVED", "ACTIVE", "RENEWING", "SUSPENDED"] } } }),
        tx.booking.count({ where: { status: { in: ["ACTIVE", "RENEWING"] } } }),
      ]);
      return { requested, approved, active };
    });
  }
}
