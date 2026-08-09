import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import type { RoleAssignment } from "@rentos/domain";
import { ExtractJwt, Strategy } from "passport-jwt";

import type { AuthenticatedUser } from "../../common/types/express-request.js";

interface JwtPayload {
  sub: string;
  tenantId: string | null;
  organizationId: string | null;
  kind: "STAFF" | "CUSTOMER";
  roles: string[];
  /** BUILD-SPEC C2 — role × scope assignments. Absent on legacy/customer tokens. */
  roleAssignments?: RoleAssignment[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET is not set.");
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    return {
      id: payload.sub,
      tenantId: payload.tenantId,
      organizationId: payload.organizationId ?? null,
      kind: payload.kind,
      roles: payload.roles,
      roleAssignments: payload.roleAssignments ?? [],
    };
  }
}
