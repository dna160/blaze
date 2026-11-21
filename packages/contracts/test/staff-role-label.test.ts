import { describe, expect, it } from "vitest";

import { CreateStaffUserRequestSchema, staffRoleLabel } from "../src/auth.js";

describe("staffRoleLabel (docs/RBAC.md §2)", () => {
  it("uses the client's six names", () => {
    expect(staffRoleLabel("ADMIN", "ORGANIZATION")).toBe("Super Admin");
    expect(staffRoleLabel("ADMIN", "TENANT")).toBe("Admin");
    expect(staffRoleLabel("FINANCE", "TENANT")).toBe("Finance");
    expect(staffRoleLabel("SUPERVISOR", "TENANT")).toBe("Supervisor (SPV)");
    expect(staffRoleLabel("STAFF", "TENANT")).toBe("Staff");
  });

  it("calls FINANCE at organization scope Super Finance — there is no finance manager", () => {
    expect(staffRoleLabel("FINANCE", "ORGANIZATION")).toBe("Super Finance");
  });

  it("names an organization-scoped supervisor as covering every branch", () => {
    expect(staffRoleLabel("SUPERVISOR", "ORGANIZATION")).toBe("Supervisor (semua cabang)");
  });
});

describe("CreateStaffUserRequestSchema (PRD go-live 2 §6.1)", () => {
  const base = { email: "Tiara@Example.Test", displayName: "Tiara", role: "STAFF", scope: "TENANT" };

  it("takes no password: the account gets a set-password link instead", () => {
    expect(CreateStaffUserRequestSchema.parse(base)).toEqual({ ...base, email: "tiara@example.test" });
  });

  it("refuses a typed password rather than silently ignoring it", () => {
    expect(CreateStaffUserRequestSchema.safeParse({ ...base, password: "typed-by-an-admin" }).success).toBe(false);
  });
});
