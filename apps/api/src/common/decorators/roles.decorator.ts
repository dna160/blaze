import { SetMetadata } from "@nestjs/common";

export const ROLES_KEY = "roles";

/** Console RBAC per PRD Appendix C. Roles are checked as "any of" — a user needs at least one listed role. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
