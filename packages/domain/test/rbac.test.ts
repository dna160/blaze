import { describe, expect, it } from "vitest";

import {
  can,
  capabilitiesFor,
  hasOrganizationScope,
  roleAppliesToTenant,
  CLIENT_ROLE_ENCODING,
  type Capability,
  type RoleAssignment,
} from "../src/rbac/capability-matrix.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

// The six client roles, per docs/RBAC.md §2.
const superAdmin: RoleAssignment = { role: "ADMIN", scope: "ORGANIZATION", tenantIds: [] };
const admin: RoleAssignment = { role: "ADMIN", scope: "TENANT", tenantIds: [TENANT_A] };
const superFinance: RoleAssignment = { role: "FINANCE", scope: "ORGANIZATION", tenantIds: [] };
const finance: RoleAssignment = { role: "FINANCE", scope: "TENANT", tenantIds: [TENANT_A] };
const spv: RoleAssignment = { role: "SUPERVISOR", scope: "TENANT", tenantIds: [TENANT_A] };
const staff: RoleAssignment = { role: "STAFF", scope: "TENANT", tenantIds: [TENANT_A] };

describe("RBAC capability matrix (BUILD-SPEC C2, docs/RBAC.md §3) — cell by cell", () => {
  // Expected matrix, transcribed from the spec table. Column order: ADMIN, FINANCE, SUPERVISOR, STAFF.
  const MATRIX: Record<Capability, [boolean, boolean, boolean, boolean]> = {
    approve_booking: [true, false, true, false],
    create_booking: [true, false, true, true],
    record_payment: [true, true, true, true],
    verify_payment: [true, true, false, false],
    void_invoice: [true, false, true, false],
    backdate: [true, false, true, false],
    price_override: [true, false, true, false],
    approve_deposit_refund: [true, true, false, false],
    run_reports: [true, true, true, false],
    manage_users: [true, false, false, false],
    delete_any: [true, false, false, false],
    fire_waitlist: [true, false, true, false],
  };

  const roles = [admin, finance, spv, staff];

  for (const [cap, expected] of Object.entries(MATRIX) as [Capability, boolean[]][]) {
    it(`${cap}: ADMIN=${expected[0]} FINANCE=${expected[1]} SUPERVISOR=${expected[2]} STAFF=${expected[3]}`, () => {
      roles.forEach((r, i) => {
        expect(can([r], cap, TENANT_A)).toBe(expected[i]);
      });
    });
  }
});

describe("RBAC — the four denials that gate R0", () => {
  it("staff cannot void an invoice", () => {
    expect(can([staff], "void_invoice", TENANT_A)).toBe(false);
  });
  it("supervisor cannot verify a payment (maker-checker verifier side)", () => {
    expect(can([spv], "verify_payment", TENANT_A)).toBe(false);
  });
  it("finance cannot delete", () => {
    expect(can([finance], "delete_any", TENANT_A)).toBe(false);
  });
  it("tenant-scoped admin cannot act on a sibling branch", () => {
    expect(can([admin], "approve_booking", TENANT_A)).toBe(true);
    expect(can([admin], "approve_booking", TENANT_B)).toBe(false);
  });
});

describe("RBAC — scope axis", () => {
  it("ORGANIZATION scope reaches any tenant", () => {
    expect(roleAppliesToTenant(superAdmin, TENANT_A)).toBe(true);
    expect(roleAppliesToTenant(superAdmin, TENANT_B)).toBe(true);
    expect(can([superAdmin], "delete_any", TENANT_B)).toBe(true);
  });
  it("TENANT scope reaches only listed tenants", () => {
    expect(roleAppliesToTenant(admin, TENANT_A)).toBe(true);
    expect(roleAppliesToTenant(admin, TENANT_B)).toBe(false);
  });
  it("a two-branch supervisor reaches both listed branches (Ko Yudi's scenario)", () => {
    const dualSpv: RoleAssignment = { role: "SUPERVISOR", scope: "TENANT", tenantIds: [TENANT_A, TENANT_B] };
    expect(can([dualSpv], "approve_booking", TENANT_A)).toBe(true);
    expect(can([dualSpv], "approve_booking", TENANT_B)).toBe(true);
  });
  it("hasOrganizationScope drives the cross-tenant read path", () => {
    expect(hasOrganizationScope([superFinance])).toBe(true);
    expect(hasOrganizationScope([finance])).toBe(false);
  });
  it("super finance can run reports across the org but cannot create bookings", () => {
    expect(can([superFinance], "run_reports", TENANT_B)).toBe(true);
    expect(can([superFinance], "create_booking", TENANT_B)).toBe(false);
  });
});

describe("RBAC — client role encoding is complete", () => {
  it("maps all six client names", () => {
    expect(Object.keys(CLIENT_ROLE_ENCODING).sort()).toEqual(
      ["ADMIN", "FINANCE", "SPV", "STAFF", "SUPER_ADMIN", "SUPER_FINANCE"].sort(),
    );
  });
  it("capabilitiesFor unions multiple assignments", () => {
    const caps = capabilitiesFor([staff, finance]);
    expect(caps.has("create_booking")).toBe(true); // from staff
    expect(caps.has("verify_payment")).toBe(true); // from finance
    expect(caps.has("delete_any")).toBe(false);
  });
});
