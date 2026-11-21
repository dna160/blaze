import { describe, expect, it } from "vitest";

import {
  approvableChangeTypes,
  canApproveChange,
  checkChangeDecision,
  DEFAULT_APPROVAL_POLICY,
  resolveApprovalPolicy,
  selfApprovesOnRequest,
  type ChangeRequestType,
} from "../src/rbac/approval-policy.js";
import type { BaseRole, RoleAssignment, RoleScope } from "../src/rbac/capability-matrix.js";

const KBJ = "tenant-kebon-jeruk";
const SETIABUDI = "tenant-setiabudi";

const hold = (role: BaseRole, scope: RoleScope, tenantIds: string[] = [KBJ]): RoleAssignment => ({
  role,
  scope,
  tenantIds: scope === "ORGANIZATION" ? [] : tenantIds,
});

describe("default approval policy (PRD go-live 2 §4.1) — cell by cell", () => {
  // [role, scope] -> may approve CANCEL / CHANGE_START_DATE for a Kebon Jeruk booking.
  const cells: Array<[BaseRole, RoleScope, boolean, boolean]> = [
    ["ADMIN", "ORGANIZATION", true, true], // super admin
    ["ADMIN", "TENANT", false, true], // branch admin: date change yes, cancellation no
    ["SUPERVISOR", "ORGANIZATION", false, true],
    ["SUPERVISOR", "TENANT", false, true],
    ["FINANCE", "ORGANIZATION", false, false], // super finance
    ["FINANCE", "TENANT", false, false],
    ["STAFF", "ORGANIZATION", false, false],
    ["STAFF", "TENANT", false, false],
  ];
  for (const [role, scope, cancel, dateChange] of cells) {
    it(`${role} x ${scope}: CANCEL=${cancel} CHANGE_START_DATE=${dateChange}`, () => {
      const roles = [hold(role, scope)];
      expect(canApproveChange(roles, "CANCEL", KBJ)).toBe(cancel);
      expect(canApproveChange(roles, "CHANGE_START_DATE", KBJ)).toBe(dateChange);
      expect(approvableChangeTypes(roles, KBJ)).toEqual([...(cancel ? ["CANCEL"] : []), ...(dateChange ? ["CHANGE_START_DATE"] : [])]);
    });
  }

  it("a branch-scoped manager only approves for a branch they cover", () => {
    const spvSetiabudi = [hold("SUPERVISOR", "TENANT", [SETIABUDI])];
    expect(canApproveChange(spvSetiabudi, "CHANGE_START_DATE", KBJ)).toBe(false);
    expect(canApproveChange(spvSetiabudi, "CHANGE_START_DATE", SETIABUDI)).toBe(true);
    // Organization scope covers every branch.
    expect(canApproveChange([hold("SUPERVISOR", "ORGANIZATION")], "CHANGE_START_DATE", SETIABUDI)).toBe(true);
    expect(canApproveChange([hold("ADMIN", "ORGANIZATION")], "CANCEL", SETIABUDI)).toBe(true);
  });

  it("nobody with no roles approves anything", () => {
    expect(approvableChangeTypes([], KBJ)).toEqual([]);
  });

  it("a user's roles add up: staff here, supervisor there", () => {
    const roles = [hold("STAFF", "TENANT", [KBJ]), hold("SUPERVISOR", "TENANT", [SETIABUDI])];
    expect(canApproveChange(roles, "CHANGE_START_DATE", KBJ)).toBe(false);
    expect(canApproveChange(roles, "CHANGE_START_DATE", SETIABUDI)).toBe(true);
  });
});

describe("the decider is never the requester", () => {
  const superAdmin = [hold("ADMIN", "ORGANIZATION")];
  const supervisor = [hold("SUPERVISOR", "TENANT")];
  const check = (type: ChangeRequestType, deciderRoles: RoleAssignment[], requesterUserId: string, deciderUserId: string) =>
    checkChangeDecision({ type, deciderRoles, requesterUserId, deciderUserId, tenantId: KBJ });

  it("refuses a decision on one's own request — admins included", () => {
    expect(check("CHANGE_START_DATE", supervisor, "u1", "u1")).toEqual({ allowed: false, denial: "SELF_DECISION" });
    expect(check("CHANGE_START_DATE", superAdmin, "u1", "u1")).toEqual({ allowed: false, denial: "SELF_DECISION" });
    expect(check("CANCEL", superAdmin, "u1", "u1")).toEqual({ allowed: false, denial: "SELF_DECISION" });
  });

  it("allows another approver", () => {
    expect(check("CHANGE_START_DATE", supervisor, "u1", "u2")).toEqual({ allowed: true });
    expect(check("CANCEL", superAdmin, "u1", "u2")).toEqual({ allowed: true });
  });

  it("says 'not an approver' before it says 'your own request'", () => {
    // A supervisor cannot approve a cancellation, theirs or anyone's.
    expect(check("CANCEL", supervisor, "u1", "u2")).toEqual({ allowed: false, denial: "NOT_AN_APPROVER" });
    expect(check("CANCEL", supervisor, "u1", "u1")).toEqual({ allowed: false, denial: "NOT_AN_APPROVER" });
    expect(check("CANCEL", [hold("ADMIN", "TENANT")], "u1", "u2")).toEqual({ allowed: false, denial: "NOT_AN_APPROVER" });
  });
});

describe("the one-step path: a super admin's own cancellation", () => {
  it("self-approves only CANCEL, only for ADMIN x ORGANIZATION", () => {
    expect(selfApprovesOnRequest([hold("ADMIN", "ORGANIZATION")], "CANCEL", KBJ)).toBe(true);
    expect(selfApprovesOnRequest([hold("ADMIN", "ORGANIZATION")], "CHANGE_START_DATE", KBJ)).toBe(false);
    expect(selfApprovesOnRequest([hold("ADMIN", "TENANT")], "CANCEL", KBJ)).toBe(false);
    expect(selfApprovesOnRequest([hold("SUPERVISOR", "ORGANIZATION")], "CANCEL", KBJ)).toBe(false);
    expect(selfApprovesOnRequest([hold("SUPERVISOR", "TENANT")], "CHANGE_START_DATE", KBJ)).toBe(false);
  });

  it("does not apply when the policy takes cancellations away from admins", () => {
    const policy = resolveApprovalPolicy({ CANCEL: { roles: ["FINANCE"], scope: "ORGANIZATION" } });
    expect(selfApprovesOnRequest([hold("ADMIN", "ORGANIZATION")], "CANCEL", KBJ, policy)).toBe(false);
  });

  it("still does not let a tenant admin self-approve when the policy lets tenant admins approve", () => {
    const policy = resolveApprovalPolicy({ CANCEL: { roles: ["ADMIN"], scope: "ANY" } });
    expect(canApproveChange([hold("ADMIN", "TENANT")], "CANCEL", KBJ, policy)).toBe(true);
    expect(selfApprovesOnRequest([hold("ADMIN", "TENANT")], "CANCEL", KBJ, policy)).toBe(false);
  });
});

describe("resolveApprovalPolicy — a stored policy, with defaults per type", () => {
  it("is the default when nothing is stored", () => {
    expect(resolveApprovalPolicy({})).toEqual(DEFAULT_APPROVAL_POLICY);
    expect(resolveApprovalPolicy(null)).toEqual(DEFAULT_APPROVAL_POLICY);
    expect(resolveApprovalPolicy("nonsense")).toEqual(DEFAULT_APPROVAL_POLICY);
  });

  it("applies §12 Q2's other answer: date changes by admins only", () => {
    const policy = resolveApprovalPolicy({ CHANGE_START_DATE: { roles: ["ADMIN"], scope: "ANY" } });
    expect(canApproveChange([hold("SUPERVISOR", "TENANT")], "CHANGE_START_DATE", KBJ, policy)).toBe(false);
    expect(canApproveChange([hold("ADMIN", "TENANT")], "CHANGE_START_DATE", KBJ, policy)).toBe(true);
    // The type that was not set keeps its default.
    expect(policy.CANCEL).toEqual(DEFAULT_APPROVAL_POLICY.CANCEL);
  });

  it("falls back to the default for a malformed rule instead of widening or emptying it", () => {
    for (const bad of [{ roles: [], scope: "ANY" }, { roles: ["OWNER"], scope: "ANY" }, { roles: ["ADMIN"], scope: "EVERYONE" }, { roles: "ADMIN", scope: "ANY" }, 7]) {
      expect(resolveApprovalPolicy({ CANCEL: bad }).CANCEL).toEqual(DEFAULT_APPROVAL_POLICY.CANCEL);
    }
  });
});
