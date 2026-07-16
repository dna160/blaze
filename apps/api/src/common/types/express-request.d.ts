import type { ResolvedTenant } from "../../tenancy/tenancy.service.js";

export interface AuthenticatedUser {
  id: string;
  tenantId: string | null;
  kind: "STAFF" | "CUSTOMER";
  roles: string[];
}

declare module "express" {
  interface Request {
    /** Resolved from Host header / X-Tenant-Slug (dev only) — see TenantMiddleware. Fallback for unauthenticated routes. */
    tenant?: ResolvedTenant;
    /** Set by JwtAuthGuard from the signed token — authoritative source of tenant scope once authenticated. */
    user?: AuthenticatedUser;
  }
}
