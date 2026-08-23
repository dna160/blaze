import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import {
  getMessagingConfigView,
  messagingConfigKey,
  resolveMessagingConfig,
  saveMessagingConfig,
  withOrgReadContext,
  type ResolvedMessagingConfig,
} from "@rentos/database";
import { can, hasOrganizationScope } from "@rentos/domain";

import { NotificationsService } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type {
  MessagingConfigResponse,
  TestMessagingRequest,
  TestMessagingResponse,
  UpdateMessagingConfigRequest,
} from "@rentos/contracts";

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

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

  // ---------------------------------------------------------------------------
  // #40 — messaging setup. One WhatsApp number per organization, all branches.
  // ---------------------------------------------------------------------------

  private assertOrgId(user: AuthenticatedUser): string {
    if (!user.organizationId) throw new ForbiddenException("No organization on session.");
    return user.organizationId;
  }

  async getMessagingConfig(user: AuthenticatedUser): Promise<MessagingConfigResponse> {
    const view = await getMessagingConfigView(this.prisma.raw, this.assertOrgId(user));
    return { ...view, canStoreSecrets: messagingConfigKey() !== null };
  }

  async updateMessagingConfig(user: AuthenticatedUser, body: UpdateMessagingConfigRequest): Promise<MessagingConfigResponse> {
    const orgId = this.assertOrgId(user);
    if (body.accessToken && messagingConfigKey() === null) {
      // Refuse rather than store it readable. Better a clear error now than a
      // credential sitting in plaintext in a JSON column nobody re-audits.
      throw new BadRequestException(
        "MESSAGING_CONFIG_KEY is not set on the API, so an access token cannot be stored securely. " +
          "Generate one with `openssl rand -hex 32`, set it, and restart before saving a token.",
      );
    }
    const current = await getMessagingConfigView(this.prisma.raw, orgId);
    if (body.provider === "whatsapp_cloud" && !body.accessToken && !current.hasAccessToken) {
      throw new BadRequestException("An access token is required the first time WhatsApp Cloud is enabled.");
    }
    const view = await saveMessagingConfig(this.prisma.raw, orgId, body, user.id);
    return { ...view, canStoreSecrets: true };
  }

  /**
   * Prove a credential works before committing to it. When the caller supplies
   * a token/number they are used as-is (nothing is written), otherwise the
   * saved config for the user's active branch is resolved. Failures come back
   * as `{ ok: false, error }` rather than a 500 — a bad credential is an
   * expected answer here, not a server fault.
   */
  async testMessaging(user: AuthenticatedUser, body: TestMessagingRequest): Promise<TestMessagingResponse> {
    this.assertOrgId(user);
    if (!user.tenantId) throw new ForbiddenException("A branch session is required to send a test.");

    let config: ResolvedMessagingConfig;
    if (body.accessToken && body.phoneNumberId) {
      config = {
        provider: "whatsapp_cloud",
        whatsapp: { accessToken: body.accessToken, phoneNumberId: body.phoneNumberId },
        source: "organization",
      };
    } else {
      config = await resolveMessagingConfig(this.prisma.raw, user.tenantId);
    }

    try {
      const result = await this.notifications.sendTestMessage(config, body.to, "otp_code", { code: "123456" });
      return { ok: true, provider: config.provider, providerRef: result.providerRef, error: null };
    } catch (err) {
      return { ok: false, provider: config.provider, providerRef: null, error: (err as Error).message };
    }
  }
}
