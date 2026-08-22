import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { withOrgReadContext } from "@rentos/database";
import { can, hasOrganizationScope } from "@rentos/domain";

import { PrismaService } from "../prisma/prisma.service.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";

/**
 * BUILD-SPEC C1 — head-office (organization) surface. Provides the tenant
 * switcher list and the READ-ONLY cross-tenant financial view. Every read here
 * goes through withOrgReadContext (the separate app.organization_id session var)
 * so RLS — not application code — is what actually spans the branches. There is
 * NO write path in this service, by design: cross-tenant writes stay impossible.
 */
@Injectable()
export class OrganizationService {
  constructor(private readonly prisma: PrismaService) {}

  private assertOrgScope(user: AuthenticatedUser): string {
    if (!user.organizationId || !hasOrganizationScope(user.roleAssignments)) {
      throw new ForbiddenException("Organization-scoped role required.");
    }
    return user.organizationId;
  }

  /** The branches the user can switch between. tenants is not RLS-scoped (it is the
   *  bootstrap registry), so this is a safe raw read filtered to the user's org. */
  async listBranches(user: AuthenticatedUser) {
    const orgId = user.organizationId;
    if (!orgId) throw new ForbiddenException("No organization on session.");
    // A tenant-scoped user only sees the branches their roles cover; an
    // org-scoped user sees the whole org.
    const all = await this.prisma.raw.tenant.findMany({
      where: { organizationId: orgId },
      select: { id: true, slug: true, name: true },
      orderBy: { name: "asc" },
    });
    if (hasOrganizationScope(user.roleAssignments)) return all;
    const allowed = new Set(user.roleAssignments.flatMap((r) => r.tenantIds));
    return all.filter((t) => allowed.has(t.id));
  }

  /**
   * B2 — HO sees FULL financials across every branch. Aggregated per tenant via
   * the org-read RLS scope. Read-only.
   */
  async financialSummary(user: AuthenticatedUser) {
    const orgId = this.assertOrgScope(user);
    return withOrgReadContext(this.prisma.raw, orgId, async (tx) => {
      const invoices = await tx.invoice.groupBy({
        by: ["tenantId", "status"],
        _sum: { totalAmount: true },
        _count: { _all: true },
      });
      const tenants = await this.prisma.raw.tenant.findMany({
        where: { organizationId: orgId },
        select: { id: true, name: true },
      });
      const nameById = new Map(tenants.map((t) => [t.id, t.name]));
      const byTenant: Record<string, { name: string; byStatus: Record<string, { count: number; total: string }> }> = {};
      for (const row of invoices) {
        const entry = (byTenant[row.tenantId] ??= { name: nameById.get(row.tenantId) ?? row.tenantId, byStatus: {} });
        entry.byStatus[row.status] = {
          count: row._count._all,
          total: (row._sum.totalAmount ?? 0).toString(),
        };
      }
      return { organizationId: orgId, branches: byTenant };
    });
  }

  /**
   * BUILD-SPEC #45 — branch onboarding wizard (backend). Provisions a NEW,
   * EMPTY branch (Tenant) under the caller's organization. Requires an
   * ORGANIZATION-scoped role holding manage_users (a Super Admin). The new
   * branch starts empty — no assets, no customers — ready for the catalog to be
   * built up. Supports B8 (one mockup now, more branches once confirmed) and the
   * verbally-promised "unlimited tenants" without a code change per branch.
   *
   * `tenants` is the bootstrap registry (not RLS-scoped), so this is a safe raw
   * write filtered to the caller's own org — a branch can only be created under
   * the org the caller belongs to.
   */
  async provisionBranch(
    user: AuthenticatedUser,
    params: { slug: string; name: string; timezone?: string; isPkp?: boolean; primaryDomain?: string; locationAddress?: string },
  ) {
    const orgId = this.assertOrgScope(user);
    if (!can(user.roleAssignments, "manage_users")) {
      throw new ForbiddenException("Provisioning a branch requires an admin (manage_users) role.");
    }
    if (!/^[a-z0-9-]{3,}$/.test(params.slug)) {
      throw new BadRequestException("slug must be lowercase alphanumeric/dashes, min 3 chars.");
    }

    const existing = await this.prisma.raw.tenant.findUnique({ where: { slug: params.slug } });
    if (existing) throw new BadRequestException(`A branch with slug "${params.slug}" already exists.`);

    const tenant = await this.prisma.raw.tenant.create({
      data: {
        organizationId: orgId,
        slug: params.slug,
        name: params.name,
        isPkp: params.isPkp ?? false,
        timezone: params.timezone ?? "Asia/Jakarta",
        // Monthly-only + bank-transfer/card defaults (C3, #27) match the org's storage vertical.
        featureFlags: { allowSubMonthly: false, paymentMethods: ["MANUAL_TRANSFER", "CARD"], deposits_enabled: true, kyc_required: true, contract_required: true },
        ...(params.primaryDomain ? { domains: { create: { domain: params.primaryDomain, isPrimary: true } } } : {}),
        ...(params.locationAddress ? { locations: { create: { name: params.name, address: params.locationAddress } } } : {}),
      },
    });
    return { id: tenant.id, slug: tenant.slug, name: tenant.name, organizationId: orgId };
  }
}
