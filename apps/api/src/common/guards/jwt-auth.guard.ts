import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import type { Request } from "express";

/**
 * Every authenticated route in this API needs two things checked, not
 * one: that the JWT is valid (passport's job), and that the session's
 * tenantId agrees with the request's resolved tenant (req.tenant, from
 * Host/X-Tenant-Slug) — otherwise a valid token from tenant A combined
 * with a `X-Tenant-Slug` header for tenant B reads/writes tenant B's
 * data, since @CurrentTenant() (unlike @CurrentTenantId()) trusts
 * req.tenant directly with no JWT-preference fallback.
 *
 * This used to be a separate opt-in `TenantMatchGuard` that individual
 * controllers had to remember to add alongside JwtAuthGuard on every
 * route. It quietly went missing from ~10 authenticated endpoints across
 * several modules (booking's `get`/`mine`/`pending`, all of
 * DepositsController including its mutating routes, FinanceController's
 * createCreditNote, CrmController, AgreementsController, KycController's
 * getFile/review, SwapRequestsController's queue) — a real cross-tenant
 * data leak, only found once a second tenant with its own staff account
 * existed to test against (docs/HANDOFF.md Session 16). Folding the
 * check in here instead means a new authenticated route gets it for
 * free and can't ship without it by omission.
 *
 * A null `req.user.tenantId` (platform admin, no tenant scope — see
 * User.tenantId's doc comment) skips the check by design; that role
 * isn't wired into any controller yet (Phase 4).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") implements CanActivate {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const authenticated = await super.canActivate(context);
    if (!authenticated) return false;

    const req = context.switchToHttp().getRequest<Request>();
    if (req.user?.tenantId && req.tenant?.id && req.user.tenantId !== req.tenant.id) {
      throw new ForbiddenException("Session tenant does not match the request domain.");
    }
    return true;
  }
}
