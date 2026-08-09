import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { can, type Capability } from "@rentos/domain";
import type { Request } from "express";

import { CAPABILITY_KEY } from "../decorators/require-capability.decorator.js";

/**
 * BUILD-SPEC C2 — authorizes a route against the role × scope capability matrix.
 * Must run after JwtAuthGuard (reads req.user). Semantics:
 *
 *  - Vendor platform admin (req.user.tenantId === null) bypasses, matching the
 *    long-standing JwtAuthGuard behavior (that role isn't wired to controllers).
 *  - Otherwise the caller must hold at least ONE of the required capabilities,
 *    AND the granting role assignment must reach the request's ACTIVE tenant
 *    (req.tenant.id). This is what denies a branch-A admin a branch-B route and
 *    confines an ORG-scoped user's WRITE to their active tenant (RLS then
 *    enforces the row-level write boundary). Cross-tenant READS use the org-read
 *    path (withOrgReadContext), not this guard.
 *
 * The existing maker-checker (recorder != verifier) is enforced separately in the
 * service layer and is unaffected by this guard — verify_payment here only grants
 * the RIGHT to verify; it never lets someone verify their own recording.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Capability[]>(CAPABILITY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user;
    if (!user) throw new ForbiddenException("Authentication required.");

    // Vendor platform admin — no tenant scope, bypasses the matrix by design.
    if (user.tenantId === null) return true;

    const activeTenantId = req.tenant?.id ?? user.tenantId ?? undefined;
    const ok = required.some((capability) => can(user.roleAssignments, capability, activeTenantId));
    if (!ok) {
      throw new ForbiddenException(`Requires one of capabilities: ${required.join(", ")}`);
    }
    return true;
  }
}
