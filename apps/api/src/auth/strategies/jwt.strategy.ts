import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import type { RoleAssignment } from "@rentos/domain";
import { ExtractJwt, Strategy } from "passport-jwt";

import type { AuthenticatedUser } from "../../common/types/express-request.js";
import { PrismaService } from "../../prisma/prisma.service.js";

interface JwtPayload {
  sub: string;
  tenantId: string | null;
  organizationId: string | null;
  kind: "STAFF" | "CUSTOMER";
  roles: string[];
  /** BUILD-SPEC C2 — role × scope assignments. Absent on legacy/customer tokens. */
  roleAssignments?: RoleAssignment[];
  /** Issued-at, seconds. Set by jsonwebtoken (or explicitly — see AuthService.issueStaffSession). */
  iat?: number;
}

/**
 * True when a staff token was issued before the account's password last
 * changed — i.e. it belongs to a session that the change revoked
 * (PRD go-live 2 §6.1 "changing a password revokes the user's other sessions").
 * Both sides are whole seconds: `passwordChangedAt` is always stored on a
 * second boundary, one second ahead of the change, and the session that made
 * the change is re-issued with exactly that `iat`.
 */
export function issuedBeforePasswordChange(iat: number | undefined, passwordChangedAt: Date | null): boolean {
  if (!passwordChangedAt) return false;
  if (typeof iat !== "number") return true;
  return iat < Math.floor(passwordChangedAt.getTime() / 1000);
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET is not set.");
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  /**
   * A customer session is what its token says. A STAFF session is also checked
   * against the account as it is NOW, on every request, because three things
   * must take effect immediately rather than when a 12-hour token runs out:
   * the account was suspended or deleted; its password changed (every other
   * session is revoked); or it must change its password before doing anything
   * else. One primary-key read per staff request buys that.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user: AuthenticatedUser = {
      id: payload.sub,
      tenantId: payload.tenantId,
      organizationId: payload.organizationId ?? null,
      kind: payload.kind,
      roles: payload.roles,
      roleAssignments: payload.roleAssignments ?? [],
    };
    if (payload.kind !== "STAFF") return user;

    const select = { status: true, mustChangePassword: true, passwordChangedAt: true } as const;
    const account = payload.tenantId
      ? await this.prisma.runInTenantContext(payload.tenantId, (tx) => tx.user.findUnique({ where: { id: payload.sub }, select }))
      : await this.prisma.runInPlatformContext((tx) => tx.user.findFirst({ where: { id: payload.sub, tenantId: null }, select }));

    if (!account || account.status !== "ACTIVE") {
      throw new UnauthorizedException("This account is no longer active. Sign in again.");
    }
    if (issuedBeforePasswordChange(payload.iat, account.passwordChangedAt)) {
      throw new UnauthorizedException("Your password was changed. Sign in again.");
    }
    return { ...user, mustChangePassword: account.mustChangePassword };
  }
}
