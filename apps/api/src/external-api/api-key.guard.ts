import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

import { hashApiKey } from "../api-keys/api-key.util.js";
import { PrismaService } from "../prisma/prisma.service.js";

/**
 * Auth for GET /external/* — a tenant's own systems calling in with a
 * Bearer TenantApiKey, not a staff/customer JWT. Deliberately does NOT
 * exclude TenantApiKey from RLS the way tenants/tenant_domains are: the
 * tenant must already be resolved (X-Tenant-Slug or Host — TenantMiddleware
 * runs before every guard, see tenant.middleware.ts) before this guard
 * runs, so the key lookup happens inside `runInTenantContext(req.tenant.id,
 * ...)` like every other tenant-scoped query. A caller can never probe
 * whether a given key exists under a tenant it didn't declare via the
 * header — see docs/HANDOFF.md Session 20 for the full rationale (this
 * was written specifically to avoid repeating the cross-tenant IDOR bug
 * class fixed in Session 16's JwtAuthGuard change).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.tenant) {
      throw new UnauthorizedException("Could not resolve a tenant (X-Tenant-Slug header or Host required).");
    }
    if (!req.tenant.featureFlags.api_access_enabled) {
      throw new UnauthorizedException("External API access is not enabled for this tenant.");
    }

    const authHeader = req.header("authorization");
    const presentedKey = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    if (!presentedKey) throw new UnauthorizedException("Missing Bearer API key.");

    const tenantId = req.tenant.id;
    const keyHash = hashApiKey(presentedKey);
    const record = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.tenantApiKey.findFirst({ where: { keyHash, revokedAt: null } }),
    );
    if (!record) throw new UnauthorizedException("Invalid or revoked API key.");

    await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.tenantApiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }),
    );
    return true;
  }
}
