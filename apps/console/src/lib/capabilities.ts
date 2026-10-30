/**
 * What the signed-in staff member may do — decides which action buttons the
 * console shows. The API's CapabilityGuard is still what enforces it; this only
 * stops the UI offering an action the API would refuse, or hiding one it allows.
 *
 * A mirror of packages/domain/src/rbac/capability-matrix.ts, kept here because
 * the console has no runtime dependency on @rentos/domain. The domain test
 * `console-capabilities.test.ts` fails if the two ever disagree, so change both
 * together.
 *
 * Pages used to check the pre-C2 role names (SUPER_ADMIN, OPS_ADMIN,
 * FINANCE_ADMIN). Login has returned base roles (ADMIN, FINANCE, SUPERVISOR,
 * STAFF) since C2, so those checks matched nobody and every action button on
 * the workbench, invoices, deposits and reports pages was hidden.
 */

export type ConsoleBaseRole = "ADMIN" | "FINANCE" | "SUPERVISOR" | "STAFF";

export type ConsoleCapability =
  | "approve_booking"
  | "create_booking"
  | "record_payment"
  | "verify_payment"
  | "void_invoice"
  | "backdate"
  | "price_override"
  | "approve_deposit_refund"
  | "run_reports"
  | "manage_users"
  | "delete_any"
  | "fire_waitlist";

export const CONSOLE_CAPABILITY_MATRIX: Readonly<Record<ConsoleBaseRole, readonly ConsoleCapability[]>> = {
  ADMIN: [
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
  ],
  FINANCE: ["record_payment", "verify_payment", "approve_deposit_refund", "run_reports"],
  SUPERVISOR: [
    "approve_booking",
    "create_booking",
    "record_payment",
    "void_invoice",
    "backdate",
    "price_override",
    "run_reports",
    "fire_waitlist",
  ],
  STAFF: ["create_booking", "record_payment"],
};

interface SessionRoles {
  roles?: string[];
  roleAssignments?: Array<{ role: string }>;
}

/**
 * Whether any of the user's roles grants `capability`. Branch scope is not
 * checked here: the console is one branch per deployment and the API refuses
 * an assignment that does not reach the active branch.
 */
export function canDo(user: SessionRoles | null | undefined, capability: ConsoleCapability): boolean {
  if (!user) return false;
  const roles = user.roleAssignments?.map((r) => r.role) ?? user.roles ?? [];
  return roles.some((role) => CONSOLE_CAPABILITY_MATRIX[role as ConsoleBaseRole]?.includes(capability) ?? false);
}
