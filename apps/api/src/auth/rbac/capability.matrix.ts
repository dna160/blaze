// BUILD-SPEC C2 — the API's view of the capability matrix is a thin re-export of
// the authoritative, unit-tested matrix in @rentos/domain. There is exactly ONE
// source of truth; this file exists so apps/api code imports RBAC from a stable
// local path and so the file the spec's §6 tree names actually exists. Do not
// redefine the matrix here — change packages/domain/src/rbac/capability-matrix.ts
// (and docs/RBAC.md) instead.
export {
  CAPABILITY_MATRIX,
  ALL_CAPABILITIES,
  CLIENT_ROLE_ENCODING,
  can,
  capabilitiesFor,
  roleAppliesToTenant,
  hasOrganizationScope,
  type BaseRole,
  type RoleScope,
  type Capability,
  type RoleAssignment,
} from "@rentos/domain";
