import type { RoleAssignment } from "@rentos/domain";

import type { ResolvedTenant } from "../../tenancy/tenancy.service.js";

export interface AuthenticatedUser {
  id: string;
  /** Active/home tenant. null => vendor platform admin (bypasses tenant checks). */
  tenantId: string | null;
  /** BUILD-SPEC C1 — the org the user belongs to; drives cross-tenant read scope. */
  organizationId: string | null;
  kind: "STAFF" | "CUSTOMER";
  /** Base role names (or ["CUSTOMER"]) — coarse checks / display only. */
  roles: string[];
  /** BUILD-SPEC C2 — full role × scope assignments; the authoritative RBAC input. */
  roleAssignments: RoleAssignment[];
}

declare module "express" {
  interface Request {
    /** Resolved from Host header / X-Tenant-Slug (dev only) — see TenantMiddleware. Fallback for unauthenticated routes. */
    tenant?: ResolvedTenant;
    /** Set by JwtAuthGuard from the signed token — authoritative source of tenant scope once authenticated. */
    user?: AuthenticatedUser;
  }
}
