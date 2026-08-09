// BUILD-SPEC C2 — authoritative role × scope capability matrix.
//
// This is the SINGLE SOURCE OF TRUTH for who can do what. It is pure (zero
// framework deps) so it can be unit-tested cell-by-cell — the Gate R0 evidence
// standard. apps/api/src/auth/rbac/capability.matrix.ts re-exports these and
// wraps them in a NestJS guard; docs/RBAC.md is the human-readable mirror. If
// you change a cell here, change docs/RBAC.md in the same commit.

/** The "what" axis — mirrors the Prisma BaseRole enum. */
export type BaseRole = "ADMIN" | "FINANCE" | "SUPERVISOR" | "STAFF";

/** The "where" axis — mirrors the Prisma RoleScope enum. */
export type RoleScope = "ORGANIZATION" | "TENANT";

/** Every gated action in the system. Rows of the BUILD-SPEC C2 table. */
export type Capability =
  | "approve_booking"
  | "create_booking" // create booking / contract / invoice / rental order
  | "record_payment"
  | "verify_payment" // maker-checker verifier side
  | "void_invoice"
  | "backdate" // backdate contract or invoice (supersede)
  | "price_override"
  | "approve_deposit_refund"
  | "run_reports" // run + export reports
  | "manage_users" // manage users, pricing config, feature flags, onboarding
  | "delete_any"
  | "fire_waitlist"; // B10 — release a unit to the waitlist queue

export const ALL_CAPABILITIES: readonly Capability[] = [
  "approve_booking",
  "create_booking",
  "record_payment",
  "verify_payment",
  "void_invoice",
  "backdate",
  "price_override",
  "approve_deposit_refund",
  "run_reports",
  "manage_users",
  "delete_any",
  "fire_waitlist",
];

/**
 * The capability matrix, exactly as docs/RBAC.md §3 and BUILD-SPEC C2. Each
 * BaseRole maps to the set of capabilities it grants. Scope (ORGANIZATION vs
 * TENANT) governs WHICH tenants those capabilities reach, handled separately by
 * roleAppliesToTenant / can — it never adds or removes a capability.
 */
export const CAPABILITY_MATRIX: Readonly<Record<BaseRole, ReadonlySet<Capability>>> = {
  ADMIN: new Set<Capability>([
    "approve_booking",
    "create_booking",
    "record_payment",
    "verify_payment",
    "void_invoice",
    "backdate",
    "price_override",
    "approve_deposit_refund",
    "run_reports",
    "manage_users",
    "delete_any",
    "fire_waitlist",
  ]),
  FINANCE: new Set<Capability>([
    // Finance records and verifies payments and approves deposit refunds, and
    // runs reports — but does NOT create bookings, void invoices, or delete.
    "record_payment",
    "verify_payment",
    "approve_deposit_refund",
    "run_reports",
  ]),
  SUPERVISOR: new Set<Capability>([
    // The on-site branch operator. Everything operational EXCEPT verifying
    // payments (maker-checker), approving deposit refunds, managing users, or
    // deleting. B10: an SPV is enough to fire the waitlist for their branch.
    "approve_booking",
    "create_booking",
    "record_payment",
    "void_invoice",
    "backdate",
    "price_override",
    "run_reports",
    "fire_waitlist",
  ]),
  STAFF: new Set<Capability>([
    // Front-desk. Can create and take payment, nothing that needs judgement.
    "create_booking",
    "record_payment",
  ]),
};

/** A user's role assignment (one row of UserRole). */
export interface RoleAssignment {
  role: BaseRole;
  scope: RoleScope;
  /** Tenant ids this assignment covers. Empty/ignored when scope = ORGANIZATION. */
  tenantIds: readonly string[];
}

/**
 * Does this assignment reach `tenantId`? ORGANIZATION scope reaches every branch
 * in the org (the caller is responsible for only pairing org-scoped assignments
 * with same-org tenants — RLS enforces the org boundary). TENANT scope reaches
 * only the listed tenants.
 */
export function roleAppliesToTenant(assignment: RoleAssignment, tenantId: string): boolean {
  if (assignment.scope === "ORGANIZATION") return true;
  return assignment.tenantIds.includes(tenantId);
}

/**
 * Can a user holding `roles` perform `capability`? When `tenantId` is given the
 * grant must come from an assignment that also reaches that tenant — this is how
 * a TENANT-scoped admin at branch A is denied an action targeting branch B, and
 * how an ORGANIZATION admin's write is still authorized only for the active
 * tenant it is applied against (RLS then confines the actual row write).
 */
export function can(
  roles: readonly RoleAssignment[],
  capability: Capability,
  tenantId?: string,
): boolean {
  return roles.some(
    (r) =>
      CAPABILITY_MATRIX[r.role]?.has(capability) &&
      (tenantId === undefined || roleAppliesToTenant(r, tenantId)),
  );
}

/** All capabilities a set of assignments grants (union), ignoring tenant scope. */
export function capabilitiesFor(roles: readonly RoleAssignment[]): Set<Capability> {
  const out = new Set<Capability>();
  for (const r of roles) {
    for (const c of CAPABILITY_MATRIX[r.role] ?? []) out.add(c);
  }
  return out;
}

/** True if any assignment is organization-scoped (drives cross-tenant read scope). */
export function hasOrganizationScope(roles: readonly RoleAssignment[]): boolean {
  return roles.some((r) => r.scope === "ORGANIZATION");
}

/**
 * The six client-facing role names, for docs/UI/seed. Encoding table is
 * docs/RBAC.md §2 — this is the machine-readable mirror.
 */
export const CLIENT_ROLE_ENCODING = {
  SUPER_ADMIN: { role: "ADMIN", scope: "ORGANIZATION" },
  ADMIN: { role: "ADMIN", scope: "TENANT" },
  SUPER_FINANCE: { role: "FINANCE", scope: "ORGANIZATION" },
  FINANCE: { role: "FINANCE", scope: "TENANT" },
  SPV: { role: "SUPERVISOR", scope: "TENANT" },
  STAFF: { role: "STAFF", scope: "TENANT" },
} as const satisfies Record<string, { role: BaseRole; scope: RoleScope }>;
