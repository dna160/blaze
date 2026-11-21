import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { PASSWORD_CHANGE_REQUIRED } from "@rentos/contracts";
import type { Request } from "express";

import { ALLOW_PENDING_PASSWORD_CHANGE_KEY } from "../decorators/allow-pending-password-change.decorator.js";

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
 *
 * PRD go-live 2 §6.1 — a third check lives here for the same reason (a route
 * cannot forget it): a staff account that must change its password may do
 * nothing else. JwtStrategy reads the flag from the account on every request;
 * this guard refuses every route not marked @AllowPendingPasswordChange()
 * with 403 + code PASSWORD_CHANGE_REQUIRED, which the console turns into a
 * redirect to the change-password page.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") implements CanActivate {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const authenticated = await super.canActivate(context);
    if (!authenticated) return false;

    const req = context.switchToHttp().getRequest<Request>();
    if (req.user?.tenantId && req.tenant?.id && req.user.tenantId !== req.tenant.id) {
      throw new ForbiddenException("Session tenant does not match the request domain.");
    }
    if (req.user?.kind === "STAFF" && req.user.mustChangePassword) {
      const allowed = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_PENDING_PASSWORD_CHANGE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allowed) {
        throw new ForbiddenException({
          code: PASSWORD_CHANGE_REQUIRED,
          message: "Anda harus mengganti kata sandi sebelum melanjutkan. / You must change your password before continuing.",
        });
      }
    }
    return true;
  }
}
