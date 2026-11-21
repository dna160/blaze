// PRD go-live 2 §4.1 — who may APPROVE a booking change request.
//
// Requesting is a capability-matrix cell (`request_booking_change`). Approving
// is not, because City Storage's rule mixes role AND scope: a cancellation is
// approved by the super admin only (ADMIN x ORGANIZATION), a date change by
// any manager who covers the branch (SUPERVISOR or ADMIN). And the rule is the
// client's to change (§12 Q2) — so it is data: `Organization.approvalPolicy`,
// with the defaults below when a type is absent or malformed.
//
// Pure, zero framework deps, unit-tested cell by cell (test/approval-policy.test.ts).

import { roleAppliesToTenant, type BaseRole, type RoleAssignment } from "./capability-matrix.js";

export type ChangeRequestType = "CANCEL" | "CHANGE_START_DATE";

export const CHANGE_REQUEST_TYPES: readonly ChangeRequestType[] = ["CANCEL", "CHANGE_START_DATE"];

/**
 * `ORGANIZATION`: the approving role must be held at organization scope (the
 * "super" roles). `ANY`: a branch-scoped holder is enough, as long as the role
 * covers the booking's branch.
 */
export type ApprovalScope = "ORGANIZATION" | "ANY";

export interface ApprovalRule {
  roles: readonly BaseRole[];
  scope: ApprovalScope;
}

export type ApprovalPolicy = Readonly<Record<ChangeRequestType, ApprovalRule>>;

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  // "Cancellation: super admin only."
  CANCEL: { roles: ["ADMIN"], scope: "ORGANIZATION" },
  // "Date change: a manager approves (supervisor or admin)."
  CHANGE_START_DATE: { roles: ["SUPERVISOR", "ADMIN"], scope: "ANY" },
};

const BASE_ROLES: readonly BaseRole[] = ["ADMIN", "FINANCE", "SUPERVISOR", "STAFF"];

function parseRule(value: unknown): ApprovalRule | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.roles) || v.roles.length === 0) return null;
  const roles = v.roles.filter((r): r is BaseRole => typeof r === "string" && (BASE_ROLES as readonly string[]).includes(r));
  if (roles.length !== v.roles.length) return null;
  if (v.scope !== "ORGANIZATION" && v.scope !== "ANY") return null;
  return { roles: [...new Set(roles)], scope: v.scope };
}

/**
 * The stored policy with the default filled in per type. A rule that is
 * missing or malformed falls back to its default — a typo in a settings row
 * must never widen who can cancel a booking, nor leave nobody able to.
 */
export function resolveApprovalPolicy(stored: unknown): ApprovalPolicy {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  return {
    CANCEL: parseRule(s.CANCEL) ?? DEFAULT_APPROVAL_POLICY.CANCEL,
    CHANGE_START_DATE: parseRule(s.CHANGE_START_DATE) ?? DEFAULT_APPROVAL_POLICY.CHANGE_START_DATE,
  };
}

/** Does this user hold an approving role, at the required scope, covering this branch? */
export function canApproveChange(
  roles: readonly RoleAssignment[],
  type: ChangeRequestType,
  tenantId: string,
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
): boolean {
  const rule = policy[type];
  return roles.some(
    (r) => rule.roles.includes(r.role) && roleAppliesToTenant(r, tenantId) && (rule.scope === "ANY" || r.scope === "ORGANIZATION"),
  );
}

/** The request types this user could approve in this branch (drives the console's Requests badge). */
export function approvableChangeTypes(
  roles: readonly RoleAssignment[],
  tenantId: string,
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
): ChangeRequestType[] {
  return CHANGE_REQUEST_TYPES.filter((t) => canApproveChange(roles, t, tenantId, policy));
}

/**
 * The ONE case in which a request needs no second person: a super admin
 * (ADMIN x ORGANIZATION) asking to cancel, when the policy lets them approve
 * cancellations at all. Their request approves itself, and the audit row says
 * so. A date change never self-approves, and neither does anyone else's cancel.
 */
export function selfApprovesOnRequest(
  roles: readonly RoleAssignment[],
  type: ChangeRequestType,
  tenantId: string,
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
): boolean {
  if (type !== "CANCEL") return false;
  const isSuperAdmin = roles.some((r) => r.role === "ADMIN" && r.scope === "ORGANIZATION");
  return isSuperAdmin && canApproveChange(roles, type, tenantId, policy);
}

export type ChangeDecisionDenial = "SELF_DECISION" | "NOT_AN_APPROVER";

/**
 * May `decider` approve or reject this request? The decider is never the
 * requester — maker-checker, as with payments, and it binds admins too.
 * (The super admin's one-step cancel is taken at request time through
 * `selfApprovesOnRequest`, never by deciding one's own pending request.)
 */
export function checkChangeDecision(params: {
  requesterUserId: string;
  deciderUserId: string;
  deciderRoles: readonly RoleAssignment[];
  type: ChangeRequestType;
  tenantId: string;
  policy?: ApprovalPolicy;
}): { allowed: true } | { allowed: false; denial: ChangeDecisionDenial } {
  if (!canApproveChange(params.deciderRoles, params.type, params.tenantId, params.policy ?? DEFAULT_APPROVAL_POLICY)) {
    return { allowed: false, denial: "NOT_AN_APPROVER" };
  }
  if (params.requesterUserId === params.deciderUserId) return { allowed: false, denial: "SELF_DECISION" };
  return { allowed: true };
}
