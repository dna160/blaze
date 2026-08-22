import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

/**
 * Allows any authenticated STAFF user (any base role), rejecting CUSTOMER
 * sessions. Used for back-office READ endpoints that every staff member may see
 * (invoice/deposit lists, proof files) — the fine-grained capability matrix
 * governs mutations, not read visibility. Must run after JwtAuthGuard.
 */
@Injectable()
export class StaffGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.user?.kind !== "STAFF") {
      throw new ForbiddenException("Staff session required.");
    }
    return true;
  }
}
