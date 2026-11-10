import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { BankAccount, BranchPublicProfile, BranchSettings, LegacyMigrationRequest, UpdateBranchSettingsRequest } from "@rentos/contracts";
import {
  applyLegacyImport,
  contactKey,
  formatDocumentNumber,
  organizationSystemNumber,
  planLegacyImport,
  resolveNumbering,
  zonedDate,
  type Prisma,
} from "@rentos/database";
import { can, hasOrganizationScope } from "@rentos/domain";

import { AuditService } from "../audit/audit.service.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import { gatewayReady, onlinePaymentsStatus } from "../payments/online-payments.js";
import { PrismaService } from "../prisma/prisma.service.js";

type TenantRow = Prisma.TenantGetPayload<{ include: { organization: { select: { legalName: true } } } }>;

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v.trim()) return [v];
  return [];
}

/**
 * PRD go-live §5.1 — the branch profile behind Settings → Branch, the
 * storefront branch page, the portal's payment instructions and every PDF.
 *
 * `tenants` and `organizations` sit outside RLS (bootstrap registry), so
 * reads and writes are raw — authorization is the org-scoped Admin check
 * below, and every write is audited with the before/after of each field.
 */
@Injectable()
export class BranchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async load(tenantId: string): Promise<TenantRow> {
    const tenant = await this.prisma.raw.tenant.findUnique({
      where: { id: tenantId },
      include: { organization: { select: { legalName: true } } },
    });
    if (!tenant) throw new NotFoundException("Branch not found.");
    return tenant;
  }

  /** An org-scoped Admin edits; a branch-scoped Admin may only look (PRD go-live §5.1). */
  static canEdit(user: AuthenticatedUser): boolean {
    return hasOrganizationScope(user.roleAssignments) && can(user.roleAssignments, "manage_users");
  }

  private publicView(t: TenantRow): BranchPublicProfile {
    const flags = (t.featureFlags ?? {}) as Record<string, unknown>;
    return {
      name: t.name,
      legalName: t.legalName ?? t.organization.legalName ?? null,
      isPkp: t.isPkp,
      contact: (t.contact ?? {}) as BranchPublicProfile["contact"],
      address: asStringArray(t.address),
      operatingHours: (t.operatingHours ?? {}) as BranchPublicProfile["operatingHours"],
      facilities: asStringArray(t.facilities),
      bankAccounts: ((t.bankAccounts ?? []) as BankAccount[]).filter((b) => b.showOnInvoice),
      onlinePaymentsEnabled: onlinePaymentsStatus(flags).enabled,
      logoDataUrl: (() => {
        const b64 = ((t.branding ?? {}) as { logoPngBase64?: string }).logoPngBase64;
        return b64 ? `data:image/png;base64,${b64}` : null;
      })(),
    };
  }

  /**
   * PRD go-live §10 — the Booqable migration, same engine as the CLI. The
   * engine itself refuses unless the organization's messaging is paused, so no
   * imported customer can be messaged mid-import. Signed-contract PDFs are not
   * attached on this path (no files in the request); the CLI attaches them.
   */
  async legacyMigration(user: AuthenticatedUser, tenantId: string, body: LegacyMigrationRequest) {
    if (!BranchService.canEdit(user)) throw new ForbiddenException("Only an organization-scoped Admin can run the legacy migration.");
    const tenant = await this.load(tenantId);
    if (user.organizationId !== tenant.organizationId) throw new ForbiddenException("This branch belongs to another organization.");
    const input = {
      customersCsv: body.customersCsv,
      rentalsCsv: body.rentalsCsv,
      openInvoicesCsv: body.openInvoicesCsv,
      minContractSeq: body.minContractSeq,
      minInvoiceSeq: body.minInvoiceSeq,
    };
    if (!body.apply) return { applied: false, plan: (await planLegacyImport(this.prisma.raw, tenantId, input)).plan };
    const result = await applyLegacyImport(this.prisma.raw, tenantId, input);
    if (result.applied) {
      await this.audit.record({
        tenantId,
        actorUserId: user.id,
        action: "LEGACY_MIGRATION_APPLIED",
        entityType: "Tenant",
        entityId: tenantId,
        metadata: { counts: result.plan.counts, totals: result.plan.totals } as Record<string, unknown>,
      });
    }
    return { applied: result.applied, plan: result.plan };
  }

  async getPublicProfile(tenantId: string): Promise<BranchPublicProfile> {
    return this.publicView(await this.load(tenantId));
  }

  async getSettings(user: AuthenticatedUser, tenantId: string): Promise<BranchSettings> {
    const t = await this.load(tenantId);
    const flags = (t.featureFlags ?? {}) as Record<string, unknown>;
    const numbering = resolveNumbering(t.numbering);
    const today = zonedDate(new Date(), t.timezone || "Asia/Jakarta");
    // Customer 36's 40th contract, and its invoice no. 123 — the same sample everywhere.
    const sample = { branchCode: t.branchCode, slug: t.slug, ...today, customerNumber: 36, seq: 40, contractSeq: 40 };
    return {
      ...this.publicView(t),
      id: t.id,
      slug: t.slug,
      branchCode: t.branchCode,
      timezone: t.timezone,
      organizationLegalName: t.organization.legalName,
      bankAccounts: (t.bankAccounts ?? []) as BankAccount[],
      numbering: (t.numbering ?? {}) as BranchSettings["numbering"],
      onlinePaymentsFlag: flags.onlinePaymentsEnabled === true,
      apiAccessEnabled: flags.api_access_enabled === true,
      gatewayReady: gatewayReady(),
      numberPreview: {
        contract: formatDocumentNumber(numbering.contract, sample),
        invoice: formatDocumentNumber(numbering.invoice, { ...sample, seq: 123 }),
      },
      canEdit: BranchService.canEdit(user),
    };
  }

  async updateSettings(user: AuthenticatedUser, tenantId: string, body: UpdateBranchSettingsRequest): Promise<BranchSettings> {
    if (!BranchService.canEdit(user)) {
      throw new ForbiddenException("Only an organization-scoped Admin can change the branch profile.");
    }
    const before = await this.load(tenantId);
    if (user.organizationId !== before.organizationId) throw new ForbiddenException("This branch belongs to another organization.");

    if (body.timezone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
      } catch {
        throw new BadRequestException(`Unknown timezone "${body.timezone}".`);
      }
    }
    if (body.branchCode) {
      const clash = await this.prisma.raw.tenant.findFirst({
        where: { organizationId: before.organizationId, branchCode: body.branchCode, id: { not: tenantId } },
        select: { name: true },
      });
      if (clash) throw new BadRequestException(`Branch code ${body.branchCode} is already used by ${clash.name}.`);
    }
    // Owner, 2026-11-09: the organization's system number sends every customer
    // message for every branch; customers who answer it get the auto-reply. Listing
    // it as a branch's CS contact would send people in a circle.
    const system = await organizationSystemNumber(this.prisma.raw, before.organizationId);
    if (system && body.contact?.whatsapp && contactKey(body.contact.whatsapp) === system) {
      throw new BadRequestException(
        "That is the organization's system number — it only sends notifications. Enter the WhatsApp number customers should contact this branch's CS on.",
      );
    }
    if (body.onlinePaymentsEnabled === true && !gatewayReady()) {
      throw new BadRequestException(
        "Online payment cannot be switched on: this deployment has no payment gateway (PAYMENT_PROVIDER=xendit). Ask your administrator to configure Xendit first.",
      );
    }

    const data: Prisma.TenantUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.legalName !== undefined) data.legalName = body.legalName;
    if (body.branchCode !== undefined) data.branchCode = body.branchCode;
    // §8.1 — applies to invoices issued from now on: tax is computed and
    // frozen on each invoice at issue, so nothing already issued changes.
    if (body.isPkp !== undefined) data.isPkp = body.isPkp;
    if (body.timezone !== undefined) data.timezone = body.timezone;
    if (body.contact !== undefined) data.contact = body.contact as Prisma.InputJsonValue;
    if (body.address !== undefined) data.address = body.address.filter((l) => l.trim()) as Prisma.InputJsonValue;
    if (body.operatingHours !== undefined) data.operatingHours = body.operatingHours as Prisma.InputJsonValue;
    if (body.facilities !== undefined) data.facilities = body.facilities as Prisma.InputJsonValue;
    if (body.bankAccounts !== undefined) data.bankAccounts = body.bankAccounts as Prisma.InputJsonValue;
    if (body.numbering !== undefined) data.numbering = body.numbering as Prisma.InputJsonValue;
    if (body.onlinePaymentsEnabled !== undefined || body.apiAccessEnabled !== undefined) {
      data.featureFlags = {
        ...((before.featureFlags ?? {}) as Record<string, unknown>),
        ...(body.onlinePaymentsEnabled !== undefined ? { onlinePaymentsEnabled: body.onlinePaymentsEnabled } : {}),
        // The API Access page: tenant API keys, GET /external/*, outbound webhooks.
        ...(body.apiAccessEnabled !== undefined ? { api_access_enabled: body.apiAccessEnabled } : {}),
      } as Prisma.InputJsonValue;
    }

    await this.prisma.raw.tenant.update({ where: { id: tenantId }, data });
    if (body.organizationLegalName !== undefined) {
      await this.prisma.raw.organization.update({ where: { id: before.organizationId }, data: { legalName: body.organizationLegalName } });
    }

    // Field-level diff — "every change is audited".
    const beforeView: Record<string, unknown> = {
      name: before.name,
      legalName: before.legalName,
      organizationLegalName: before.organization.legalName,
      branchCode: before.branchCode,
      isPkp: before.isPkp,
      timezone: before.timezone,
      contact: before.contact,
      address: before.address,
      operatingHours: before.operatingHours,
      facilities: before.facilities,
      bankAccounts: before.bankAccounts,
      numbering: before.numbering,
      onlinePaymentsEnabled: ((before.featureFlags ?? {}) as Record<string, unknown>).onlinePaymentsEnabled ?? false,
      apiAccessEnabled: ((before.featureFlags ?? {}) as Record<string, unknown>).api_access_enabled ?? false,
    };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, to] of Object.entries(body)) {
      if (to === undefined) continue;
      const from = beforeView[key];
      if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
    }
    if (Object.keys(changes).length > 0) {
      await this.audit.record({
        tenantId,
        actorUserId: user.id,
        action: "BRANCH_PROFILE_UPDATED",
        entityType: "Tenant",
        entityId: tenantId,
        metadata: { changes } as Record<string, unknown>,
      });
    }
    return this.getSettings(user, tenantId);
  }
}
