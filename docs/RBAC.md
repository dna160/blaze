# RentOS — RBAC (Role × Scope) — authoritative

**Precedence:** this file is the authoritative source for the capability matrix.
It restates and expands `docs/BUILD-SPEC.md` §3 correction **C2**. Where any
other document (including `docs/PRD.md`) disagrees on who can do what, this file
wins. The single in-code source of truth must be
`apps/api/src/auth/rbac/capability.matrix.ts` — that file and this document must
stay in lockstep; changing one without the other is a defect.

Status: **specification only.** As of this writing the codebase still has the flat
`GlobalRole` enum (`PLATFORM_ADMIN SUPER_ADMIN OPS_ADMIN FINANCE_ADMIN VIEWER`) and
a `UserRole` model with no scope column. This document defines the target of the R0
remediation, not the current state.

---

## 1. Why role × scope, not six enum values

The client named six roles. Two of them (super admin, super finance) are the same
*capability* as two others (admin, finance) applied across all branches instead of
one. Encoding all six as flat enum values duplicates every capability rule twice and
makes "cover a second branch" a schema migration. Instead, split the two independent
axes:

- **Role** = *what* a user may do (the capability bundle).
- **Scope** = *where* those capabilities apply (one branch, or the whole org).

```prisma
enum BaseRole   { ADMIN FINANCE SUPERVISOR STAFF }
enum RoleScope  { ORGANIZATION TENANT }

model UserRole {
  userId    String
  role      BaseRole
  scope     RoleScope
  tenantIds String[]   // empty when scope = ORGANIZATION; one or more when scope = TENANT
}
```

`tenantIds` is an **array**, deliberately. Ko Yudi described a person covering two
branches. An array costs nothing today and turns that case into a data edit instead
of a migration. When `scope = ORGANIZATION`, `tenantIds` is empty and the role
applies org-wide (subject to the read-only rule in §4).

---

## 2. The six client roles → encoding

| Client name | Encoding | Sees | Writes |
|---|---|---|---|
| Super Admin | `ADMIN` @ ORGANIZATION | all branches | active branch only (see §4) |
| Admin | `ADMIN` @ TENANT [one] | its branch | its branch |
| Super Finance | `FINANCE` @ ORGANIZATION | all branches | active branch only (see §4) |
| Finance | `FINANCE` @ TENANT [one] | its branch | its branch |
| SPV | `SUPERVISOR` @ TENANT [one] | its branch | its branch |
| Staff | `STAFF` @ TENANT [one] | its branch | its branch |

`PLATFORM_ADMIN` (the vendor/Alexander operator role, `tenantId: null`) is **not** a
client role and is out of the client capability matrix. It remains the platform
super-user for cross-org operations and keeps its existing behaviour.

---

## 3. Capability matrix (authoritative)

`✔` = allowed · `—` = denied (403). Columns are the **role** axis; scope governs
*which tenants* the allowed action may touch, per §4.

| Capability | Admin | Finance | Supervisor | Staff |
|---|:---:|:---:|:---:|:---:|
| Approve booking | ✔ | — | ✔ | — |
| Create booking / contract / invoice | ✔ | — | ✔ | ✔ |
| Record payment | ✔ | ✔ | ✔ | ✔ |
| **Verify** payment (maker-checker) | ✔ | ✔ | — | — |
| Void / cancel invoice | ✔ | — | ✔ | — |
| Backdate contract or invoice | ✔ | — | ✔ | — |
| Manual price override | ✔ | — | ✔ | — |
| Approve deposit refund | ✔ | ✔ | — | — |
| Run + export reports | ✔ | ✔ | ✔ | — |
| Manage users, pricing config | ✔ | — | — | — |
| Delete anything | ✔ | — | — | — |

### The four denials that gate R0

These are the negative tests that must pass, verified cell by cell, at Gate R0:

1. **Staff cannot void an invoice.** `STAFF` → void → 403.
2. **Supervisor cannot verify a payment.** `SUPERVISOR` → verify → 403.
3. **Finance cannot delete.** `FINANCE` → delete → 403.
4. **Tenant-scoped admin cannot see a sibling branch.** `ADMIN` @ TENANT[A] queries
   branch B → **zero rows**, not an error, not a leak.

---

## 4. The interaction between scope and maker-checker, and the write rule

Two invariants that must survive the R0 refactor intact:

- **Maker-checker is preserved verbatim.** The existing guard enforces
  recorder ≠ verifier on manual payments and throws 403 on violation
  (`packages/database`/`apps/api` finance path; see `docs/HANDOFF.md` Session 2 and
  16). The role×scope refactor layers *on top of* this — it never replaces it. A user
  with the `Verify payment` capability (Admin or Finance) still cannot verify a
  payment they themselves recorded. Capability grants the *right to verify*;
  maker-checker still forbids verifying *your own* recording.

- **Organization scope is read-only for cross-tenant access.** This is correction
  C1's hard rule restated for RBAC: an `ORGANIZATION`-scoped role can *read* across
  all branches, but any **write** must target the caller's currently-active tenant
  and is rejected against any other tenant. Cross-tenant reads flow through the
  separate `app.organization_id` session variable and its own read-only policy
  clause; the `app.tenant_id` write policy is **never** widened. A cross-tenant write
  bug in a franchise system is unrecoverable commercially — treat any code path that
  could let an org-scoped role write to a non-active tenant as a release blocker.

---

## 5. Test checklist (Gate R0)

- [ ] All six client roles instantiated as `UserRole` rows with correct
      `role`/`scope`/`tenantIds`.
- [ ] Each capability-matrix cell verified — every `✔` succeeds, every `—` returns
      403 — for at least one role in each column.
- [ ] The four denials in §3 explicitly asserted.
- [ ] Super Admin / Super Finance read both branches; a write by either to a
      non-active tenant is rejected.
- [ ] Tenant-scoped `ADMIN` querying a sibling branch returns **zero rows**.
- [ ] Existing maker-checker 403 still fires after the refactor.
- [ ] `capability.matrix.ts` matches this table exactly (mechanical diff, not
      eyeballed).
