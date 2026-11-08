import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { applyUserImport, hashPasswordToken, planUserImport, withOrgReadContext, withTenantContext } from "@rentos/database";
import { can, hasOrganizationScope, type BaseRole, type RoleScope } from "@rentos/domain";
import { hash } from "bcryptjs";

import { AuditService } from "../audit/audit.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

const BCRYPT_COST = 10;

/**
 * BUILD-SPEC C2 — staff user & role administration (the "set up the hierarchy"
 * surface). Every method requires the caller to hold manage_users (ADMIN) for
 * the active tenant; the CapabilityGuard enforces that on the route and each
 * method re-checks. Two invariants beyond that:
 *
 *   1. WRITES STAY SINGLE-TENANT (C1). A user is created/edited in the console's
 *      ACTIVE tenant only. An org Super Admin manages another branch by switching
 *      the active tenant, never by a cross-tenant write here.
 *   2. NO PRIVILEGE ESCALATION. Granting an ORGANIZATION-scoped role (Super Admin /
 *      Super Finance) requires the CALLER to already be organization-scoped. A
 *      branch Admin can only mint TENANT-scoped roles for their own branch.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * PRD go-live §4.4 — Settings → Users → Import CSV. Dry run unless `apply`.
   * An org-scoped Admin may import into any branch of the organization; a
   * branch Admin only into the branches they administer, and never
   * organization-wide roles. Each created user gets a single-use set-password
   * link by email (suppressed while messaging is paused, like every other
   * message) — and the links come back in the response so the admin can hand
   * them over another way. No passwords are ever set here.
   */
  async importUsers(actor: AuthenticatedUser, tenant: ResolvedTenant, csv: string, apply: boolean) {
    this.assertCanManage(actor, tenant.id);
    if (!actor.organizationId) throw new ForbiddenException("No organization on session.");
    const orgScope = hasOrganizationScope(actor.roleAssignments);
    const params = {
      organizationId: actor.organizationId,
      csv,
      defaultTenantId: tenant.id,
      allowOrganizationScope: orgScope,
      ...(orgScope ? {} : { allowedTenantIds: actor.roleAssignments.flatMap((r) => (r.role === "ADMIN" ? r.tenantIds : [])) }),
    };
    if (!apply) return { plan: await planUserImport(this.prisma.raw, params), created: [] };

    const { plan, created } = await applyUserImport(this.prisma.raw, params);
    if (!plan.canApply) throw new BadRequestException({ message: "The file has errors — nobody was created.", plan });
    const base = (process.env.CONSOLE_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
    const links = [];
    for (const c of created) {
      const link = `${base}/set-password?token=${c.token}&branch=${c.branchSlug}`;
      const branch = await this.prisma.raw.tenant.findUnique({ where: { id: c.tenantId }, select: { name: true } });
      await this.notifications.notify({
        tenantId: c.tenantId,
        channel: "EMAIL",
        templateKey: "staff_set_password",
        recipient: c.email,
        variables: { displayName: c.displayName, branchName: branch?.name ?? "", link },
      });
      links.push({ email: c.email, displayName: c.displayName, branchSlug: c.branchSlug, link });
    }
    await this.audit.record({ tenantId: tenant.id, actorUserId: actor.id, action: "USERS_IMPORTED", entityType: "User", metadata: { created: created.map((c) => c.email) } });
    return { plan, created: links };
  }

  /**
   * Redeem a set-password link (PRD go-live §4.4). Single use; expired or used
   * links answer the same way, so a guessed token learns nothing.
   */
  async setPasswordWithToken(token: string, password: string) {
    const row = await this.prisma.raw.userPasswordToken.findUnique({ where: { tokenHash: hashPasswordToken(token) } });
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      throw new BadRequestException("This link is invalid or has expired. Ask your administrator for a new one.");
    }
    const passwordHash = await hash(password, BCRYPT_COST);
    const user = await withTenantContext(this.prisma.raw, row.tenantId, (tx) =>
      tx.user.update({ where: { id: row.userId }, data: { passwordHash }, select: { email: true, tenant: { select: { slug: true } } } }),
    );
    await this.prisma.raw.userPasswordToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    await this.audit.record({ tenantId: row.tenantId, actorUserId: row.userId, action: "STAFF_PASSWORD_SET", entityType: "User", entityId: row.userId });
    return { email: user.email, branchSlug: user.tenant?.slug ?? null };
  }

  private assertCanManage(actor: AuthenticatedUser, activeTenantId: string): void {
    if (!can(actor.roleAssignments, "manage_users", activeTenantId)) {
      throw new ForbiddenException("Managing users requires an admin role for this branch.");
    }
  }

  private assertMayGrant(actor: AuthenticatedUser, scope: RoleScope): void {
    if (scope === "ORGANIZATION" && !hasOrganizationScope(actor.roleAssignments)) {
      throw new ForbiddenException("Only an organization-scoped admin can grant organization-wide roles.");
    }
  }

  /**
   * List staff. An organization-scoped admin sees every branch's staff (read-only
   * org scope); a branch admin sees only the active branch's staff.
   */
  async listUsers(actor: AuthenticatedUser, tenant: ResolvedTenant) {
    this.assertCanManage(actor, tenant.id);
    const shape = {
      select: {
        id: true,
        tenantId: true,
        email: true,
        displayName: true,
        status: true,
        roles: { select: { role: true, scope: true, tenantIds: true } },
      },
      orderBy: { createdAt: "asc" as const },
    };

    if (hasOrganizationScope(actor.roleAssignments) && actor.organizationId) {
      const [users, tenants] = await withOrgReadContext(this.prisma.raw, actor.organizationId, async (tx) => {
        const u = await tx.user.findMany(shape);
        return [u, await this.prisma.raw.tenant.findMany({ where: { organizationId: actor.organizationId! }, select: { id: true, name: true } })];
      });
      const nameById = new Map(tenants.map((t) => [t.id, t.name]));
      return users.map((u) => ({ ...u, tenantName: u.tenantId ? nameById.get(u.tenantId) ?? null : null }));
    }

    const users = await this.prisma.runInTenantContext(tenant.id, (tx) => tx.user.findMany(shape));
    return users.map((u) => ({ ...u, tenantName: tenant.name }));
  }

  /** Create a staff user in the ACTIVE tenant with one role × scope assignment. */
  async createUser(
    actor: AuthenticatedUser,
    tenant: ResolvedTenant,
    input: { email: string; displayName: string; password: string; role: BaseRole; scope: RoleScope },
  ) {
    this.assertCanManage(actor, tenant.id);
    this.assertMayGrant(actor, input.scope);

    const passwordHash = await hash(input.password, BCRYPT_COST);
    const tenantIds = input.scope === "TENANT" ? [tenant.id] : [];

    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const clash = await tx.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email: input.email } } });
      if (clash) throw new ConflictException("A user with that email already exists in this branch.");
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: input.email,
          displayName: input.displayName,
          passwordHash,
          status: "ACTIVE",
          roles: { create: { role: input.role, scope: input.scope, tenantIds } },
        },
        select: { id: true, email: true, displayName: true, status: true, roles: { select: { role: true, scope: true, tenantIds: true } } },
      });
      return user;
    });
  }

  /** Replace a user's role assignment (promote/change). Same guards as create. */
  async updateUserRole(
    actor: AuthenticatedUser,
    tenant: ResolvedTenant,
    userId: string,
    input: { role: BaseRole; scope: RoleScope },
  ) {
    this.assertCanManage(actor, tenant.id);
    this.assertMayGrant(actor, input.scope);
    const tenantIds = input.scope === "TENANT" ? [tenant.id] : [];

    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const target = await tx.user.findUnique({ where: { id: userId } });
      if (!target) throw new NotFoundException("User not found in this branch.");
      if (actor.id === userId) throw new BadRequestException("You cannot change your own role.");
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userRole.create({ data: { userId, role: input.role, scope: input.scope, tenantIds } });
      return { id: userId, role: input.role, scope: input.scope };
    });
  }

  /** Activate / deactivate a staff account (no self-deactivation). */
  async setStatus(actor: AuthenticatedUser, tenant: ResolvedTenant, userId: string, active: boolean) {
    this.assertCanManage(actor, tenant.id);
    if (actor.id === userId) throw new BadRequestException("You cannot change your own status.");
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const target = await tx.user.findUnique({ where: { id: userId } });
      if (!target) throw new NotFoundException("User not found in this branch.");
      return tx.user.update({ where: { id: userId }, data: { status: active ? "ACTIVE" : "SUSPENDED" }, select: { id: true, status: true } });
    });
  }
}
