import { Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service.js";

export interface ResolvedTenant {
  id: string;
  /** BUILD-SPEC C1 — the Organization this branch belongs to. */
  organizationId: string;
  slug: string;
  name: string;
  isPkp: boolean;
  defaultLocale: string;
  timezone: string;
  featureFlags: Record<string, unknown>;
}

@Injectable()
export class TenancyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolution order matches PRD §6: custom/subdomain first, explicit slug
   * (dev/testing convenience) second. Deliberately reads through `raw`,
   * not a tenant-scoped transaction — this IS the step that establishes
   * which tenant context to use next, so it can only run against the two
   * registry tables excluded from RLS (see enable_rls migration).
   */
  async resolveByHost(host: string | undefined): Promise<ResolvedTenant> {
    if (!host) throw new NotFoundException("No Host header to resolve a tenant from.");
    const domain = host.split(":")[0]!.toLowerCase();

    const byDomain = await this.prisma.raw.tenantDomain.findUnique({
      where: { domain },
      include: { tenant: true },
    });
    if (byDomain) return this.toResolvedTenant(byDomain.tenant);

    // Dev convenience: `<slug>.rentos.local` or `<slug>.localhost` resolves by subdomain
    // without a seeded TenantDomain row.
    const subdomain = domain.split(".")[0];
    if (subdomain) {
      const bySlug = await this.prisma.raw.tenant.findUnique({ where: { slug: subdomain } });
      if (bySlug) return this.toResolvedTenant(bySlug);
    }

    throw new NotFoundException(`No tenant found for host "${host}".`);
  }

  async resolveBySlug(slug: string): Promise<ResolvedTenant> {
    const tenant = await this.prisma.raw.tenant.findUnique({ where: { slug } });
    if (!tenant) throw new NotFoundException(`No tenant found for slug "${slug}".`);
    return this.toResolvedTenant(tenant);
  }

  private toResolvedTenant(tenant: {
    id: string;
    organizationId: string;
    slug: string;
    name: string;
    isPkp: boolean;
    defaultLocale: string;
    timezone: string;
    featureFlags: unknown;
  }): ResolvedTenant {
    return {
      id: tenant.id,
      organizationId: tenant.organizationId,
      slug: tenant.slug,
      name: tenant.name,
      isPkp: tenant.isPkp,
      defaultLocale: tenant.defaultLocale,
      timezone: tenant.timezone,
      featureFlags: (tenant.featureFlags as Record<string, unknown>) ?? {},
    };
  }
}
