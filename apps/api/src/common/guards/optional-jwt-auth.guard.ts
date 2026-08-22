import { Injectable, type ExecutionContext } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import type { Request } from "express";

/**
 * Public routes that behave better with a session when one is present —
 * the storefront booking submission (PRD v2 §4.4): an anonymous customer
 * is found/created by WhatsApp number, a signed-in one (OTP or Google) is
 * attached by session. A missing or invalid token is NOT an error here;
 * `req.user` just stays undefined. A valid token for a different tenant
 * than the request resolved is ignored rather than trusted (same rule
 * JwtAuthGuard enforces, minus the 403 — the request is still valid as an
 * anonymous one).
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard("jwt") {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.headers.authorization) return true;
    try {
      await super.canActivate(context);
    } catch {
      req.user = undefined;
      return true;
    }
    if (req.user?.tenantId && req.tenant?.id && req.user.tenantId !== req.tenant.id) {
      req.user = undefined;
    }
    return true;
  }

  override handleRequest<TUser = unknown>(_err: unknown, user: TUser | false): TUser | undefined {
    return user || undefined;
  }
}
