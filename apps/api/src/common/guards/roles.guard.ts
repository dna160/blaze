import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

import { ROLES_KEY } from "../decorators/roles.decorator.js";

/** Must run after JwtAuthGuard — reads req.user populated by the JWT strategy. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const userRoles = req.user?.roles ?? [];
    const hasRole = required.some((role) => userRoles.includes(role));
    if (!hasRole) {
      throw new ForbiddenException(`Requires one of roles: ${required.join(", ")}`);
    }
    return true;
  }
}
