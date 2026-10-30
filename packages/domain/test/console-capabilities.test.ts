import { describe, expect, it } from "vitest";

// The console mirrors the matrix because it has no runtime dependency on this
// package (apps/console/src/lib/capabilities.ts). This keeps the mirror honest.
import { CONSOLE_CAPABILITY_MATRIX, canDo } from "../../../apps/console/src/lib/capabilities.js";
import { ALL_CAPABILITIES, CAPABILITY_MATRIX, type BaseRole } from "../src/rbac/capability-matrix.js";

const ROLES: BaseRole[] = ["ADMIN", "FINANCE", "SUPERVISOR", "STAFF"];

describe("console capability mirror", () => {
  it("grants exactly what the domain matrix grants, role by role", () => {
    for (const role of ROLES) {
      expect([...CONSOLE_CAPABILITY_MATRIX[role]].sort()).toEqual([...CAPABILITY_MATRIX[role]].sort());
    }
  });

  it("answers from the base role names login actually returns", () => {
    // A Super Admin session: ADMIN at ORGANIZATION scope.
    const superAdmin = { roles: ["ADMIN"], roleAssignments: [{ role: "ADMIN" }] };
    for (const capability of ALL_CAPABILITIES) expect(canDo(superAdmin, capability)).toBe(true);
    expect(canDo({ roles: ["FINANCE"] }, "approve_booking")).toBe(false);
    expect(canDo({ roles: ["SUPERVISOR"] }, "approve_booking")).toBe(true);
    // The pre-C2 names match nothing, which is the bug this replaced.
    expect(canDo({ roles: ["SUPER_ADMIN"] }, "approve_booking")).toBe(false);
    expect(canDo(null, "approve_booking")).toBe(false);
  });
});
