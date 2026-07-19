import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { hash } from "bcryptjs";
import { generateMonthlyPlatformInvoices } from "@rentos/database";
import { BILLING_PLANS, type BillingPlanKey } from "@rentos/domain";

import { PrismaService } from "../prisma/prisma.service.js";

import type { PlatformSignupRequest } from "@rentos/contracts";

const SALT_ROUNDS = 10;

/**
 * Platform-admin surface (Session 26, PRD Phase 4 self-serve signup +
 * tenant billing) — distinct from every other service in this codebase
 * in that it deliberately operates ACROSS tenants, not within one. Every
 * per-tenant read/write still goes through `runInTenantContext` (never a
 * raw cross-tenant query) — this service just loops tenants one at a
 * time, the same shape `dunning-ladder.job.ts` already uses, rather than
 * ever bypassing RLS to see everyone's rows in one query.
 */
@Injectable()
export class PlatformService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Public, unauthenticated — this is the actual self-serve entry point.
   * `tenants`/`tenant_domains` are the two tables excluded from RLS by
   * design (see docs/HANDOFF.md "RLS enforcement"), so creating one
   * needs no tenant context; the first admin USER for it is tenant-scoped
   * from the moment it's created, so that write runs inside
   * `runInTenantContext(newTenant.id, ...)` like any other tenant write.
   */
  async signup(dto: PlatformSignupRequest) {
    const existing = await this.prisma.raw.tenant.findUnique({ where: { slug: dto.slug } });
    if (existing) throw new ConflictException(`Slug "${dto.slug}" is already taken.`);

    const tenant = await this.prisma.raw.tenant.create({
      data: {
        slug: dto.slug,
        name: dto.companyName,
        isPkp: dto.isPkp,
        defaultLocale: "id",
        timezone: "Asia/Jakarta",
        // Sensible, conservative v1 defaults — a self-serve tenant starts
        // with nothing auto-approved and no Phase 4 add-ons enabled,
        // matching how every seeded tenant's baseline flags read before
        // a specific capability is deliberately turned on for it.
        featureFlags: { deposits_enabled: true, kyc_required: false, auto_approve: false, contract_required: false },
      },
    });

    const passwordHash = await hash(dto.password, SALT_ROUNDS);
    await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const user = await tx.user.create({
        data: { tenantId: tenant.id, email: dto.adminEmail, displayName: dto.adminName, passwordHash, status: "ACTIVE" },
      });
      await tx.userRole.create({ data: { userId: user.id, role: "SUPER_ADMIN" } });
    });

    return {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      message: `Tenant "${tenant.name}" created. Sign in at /login with X-Tenant-Slug (or ?tenant=) "${tenant.slug}" using the admin email and password just set.`,
    };
  }

  async listTenantSummaries() {
    const tenants = await this.prisma.raw.tenant.findMany({ orderBy: { createdAt: "asc" } });
    const summaries = [];
    for (const tenant of tenants) {
      const activeAssetCount = await this.prisma.runInTenantContext(tenant.id, (tx) =>
        tx.asset.count({ where: { status: { not: "RETIRED" } } }),
      );
      const plan = tenant.billingPlan as BillingPlanKey;
      summaries.push({
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        billingPlan: tenant.billingPlan,
        includedAssets: BILLING_PLANS[plan].includedAssets,
        activeAssetCount,
        createdAt: tenant.createdAt.toISOString(),
      });
    }
    return summaries;
  }

  async runBillingNow() {
    const results = await generateMonthlyPlatformInvoices(this.prisma.raw);
    return { results: results.map((r) => ({ tenantSlug: r.tenantSlug, created: r.created })) };
  }

  async listInvoices() {
    const tenants = await this.prisma.raw.tenant.findMany();
    const all = [];
    for (const tenant of tenants) {
      const invoices = await this.prisma.runInTenantContext(tenant.id, (tx) =>
        tx.platformInvoice.findMany({ orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }] }),
      );
      for (const inv of invoices) {
        all.push({
          id: inv.id,
          tenantId: inv.tenantId,
          tenantSlug: tenant.slug,
          billingPlan: inv.billingPlan,
          periodYear: inv.periodYear,
          periodMonth: inv.periodMonth,
          includedAssets: inv.includedAssets,
          actualAssetCount: inv.actualAssetCount,
          planAmount: inv.planAmount.toString(),
          overageAmount: inv.overageAmount.toString(),
          totalAmount: inv.totalAmount.toString(),
          status: inv.status,
          issuedAt: inv.issuedAt.toISOString(),
          paidAt: inv.paidAt ? inv.paidAt.toISOString() : null,
        });
      }
    }
    all.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
    return all;
  }

  async markInvoicePaid(tenantId: string, invoiceId: string) {
    if (!tenantId) throw new BadRequestException("tenantId is required.");
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const invoice = await tx.platformInvoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw new NotFoundException("Platform invoice not found.");
      if (invoice.status === "PAID") throw new ConflictException("Already marked paid.");
      return tx.platformInvoice.update({ where: { id: invoiceId }, data: { status: "PAID", paidAt: new Date() } });
    });
  }
}
