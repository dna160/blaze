import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

import { TenancyService } from "../../tenancy/tenancy.service.js";

/**
 * Resolves req.tenant from `X-Tenant-Slug` when present, falling back to
 * the request's Host header (real subdomain / custom domain, PRD §6)
 * otherwise. This is a FALLBACK for unauthenticated storefront
 * browsing — authenticated MUTATING routes must prefer req.user.tenantId
 * (set from the signed JWT by JwtAuthGuard) via CurrentTenantId, and
 * TenantMatchGuard rejects any request where a signed-in session's
 * tenantId disagrees with this header. See docs/HANDOFF.md
 * "Tenant resolution across services" for the full architecture.
 *
 * X-Tenant-Slug is honored in every environment, not just dev, because
 * apps/storefront and apps/console run as separate Railway services from
 * apps/api: the browser hits the API directly on its own domain, so the
 * API never sees the tenant's actual storefront/console Host. The
 * frontend BFF resolves its OWN tenant from ITS Host (middleware.ts in
 * each Next.js app) and forwards it explicitly via this header. Trusting
 * a client-suppliable header for tenant scope would be a real hole if it
 * could influence a mutation — it can't, because every mutating route
 * requires a JWT whose tenantId was fixed at login and is cross-checked by
 * TenantMatchGuard. The only thing this header can influence unauthenticated
 * is which tenant's PUBLIC catalog you browse, which is public by design
 * (PRD §7.1.1: "prices visible without login").
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly tenancy: TenancyService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    try {
      const slugHeader = req.header("x-tenant-slug");
      req.tenant = slugHeader
        ? await this.tenancy.resolveBySlug(slugHeader)
        : await this.tenancy.resolveByHost(req.header("host"));
    } catch {
      // Left undefined; CurrentTenantId will 400 for handlers that require it.
    }
    next();
  }
}
