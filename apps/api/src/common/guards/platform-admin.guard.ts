import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

/**
 * Admits only the vendor platform admin — the staff session whose
 * `tenantId` is null (see User.tenantId in schema.prisma and
 * CapabilityGuard, which bypasses the tenant capability matrix for exactly
 * this session shape).
 *
 * CapabilityGuard cannot express this: it grants on capabilities held
 * *within* a tenant, so gating /platform on any capability would also admit
 * every tenant ADMIN — that is, let one tenant's admin onboard tenants and
 * read RentOS's own billing. Null tenancy is the whole distinction, so this
 * guard checks it directly. Must run after JwtAuthGuard.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.user?.kind !== "STAFF" || req.user.tenantId !== null) {
      throw new ForbiddenException("Platform administrator session required.");
    }
    return true;
  }
}
