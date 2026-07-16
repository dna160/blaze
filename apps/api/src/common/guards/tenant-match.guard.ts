import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

/**
 * Defense in depth for authenticated mutating routes: the Host-resolved
 * tenant (req.tenant, driven by whatever domain the request arrived on)
 * must agree with the signed JWT's tenantId (req.user.tenantId). A
 * mismatch means a session token is being replayed against the wrong
 * tenant's domain — reject rather than silently preferring one source.
 * Must run after both TenantMiddleware and JwtAuthGuard.
 */
@Injectable()
export class TenantMatchGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.user?.tenantId && req.tenant?.id && req.user.tenantId !== req.tenant.id) {
      throw new ForbiddenException("Session tenant does not match the request domain.");
    }
    return true;
  }
}
