import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { zonedDateString } from "@rentos/contracts";
import { arrearsByCustomer, chargeOvertime, MoneyRuleDisabledError, type ArrearsBadge } from "@rentos/database";
import { resolveMoneyRules, type MoneyRulesConfig } from "@rentos/domain";

import { AuditService } from "../audit/audit.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

/**
 * PRD go-live 2 §10.3 — the staff-facing side of the T&C money rules: the
 * branch's configuration (read), overtime charges (staff enter them), and the
 * arrears badge (computed on read). Late fees, overstay and deposit refund
 * tasks are the worker's (apps/worker/src/jobs/money-rules.job.ts).
 */
@Injectable()
export class MoneyRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async rulesFor(tenantId: string): Promise<MoneyRulesConfig> {
    const t = await this.prisma.raw.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { featureFlags: true } });
    return resolveMoneyRules(t.featureFlags);
  }

  /** The branch's "today" (YYYY-MM-DD) in its own timezone. */
  private today(tenant: { timezone?: string | null }) {
    return zonedDateString(new Date(), tenant.timezone || "Asia/Jakarta");
  }

  async arrears(tenant: ResolvedTenant, customerIds: string[]): Promise<Record<string, ArrearsBadge>> {
    const rules = await this.rulesFor(tenant.id);
    const map = await this.prisma.runInTenantContext(tenant.id, (tx) => arrearsByCustomer(tx, rules, customerIds, this.today(tenant)));
    return Object.fromEntries(map);
  }

  async chargeOvertime(
    tenant: ResolvedTenant,
    userId: string,
    bookingId: string,
    body: { hours: number; date?: string; note?: string | null; target?: "NEXT_INVOICE" | "ONE_OFF" },
  ) {
    const rules = await this.rulesFor(tenant.id);
    const date = body.date ?? this.today(tenant);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException("date must be YYYY-MM-DD.");
    try {
      const result = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
        const booking = await tx.booking.findUnique({ where: { id: bookingId }, select: { id: true } });
        if (!booking) throw new NotFoundException("Booking not found.");
        return chargeOvertime(tx, tenant, rules, { bookingId, hours: body.hours, note: body.note ?? null, target: body.target ?? "NEXT_INVOICE", date });
      });
      await this.audit.record({
        tenantId: tenant.id,
        actorUserId: userId,
        action: "OVERTIME_CHARGED",
        entityType: "Booking",
        entityId: bookingId,
        metadata: { hours: body.hours, date, note: body.note ?? null, ...result },
      });
      return result;
    } catch (e) {
      if (e instanceof MoneyRuleDisabledError) throw new ConflictException(e.message);
      if (e instanceof RangeError) throw new BadRequestException(e.message);
      throw e;
    }
  }
}
