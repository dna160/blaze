# RentOS — RBAC (Role × Scope) — authoritative

**Precedence:** this file is the authoritative source for the capability matrix.
It restates and expands `docs/BUILD-SPEC.md` §3 correction **C2**. Where any
other document (including `docs/PRD.md`) disagrees on who can do what, this file
wins. The single in-code source of truth must be
`apps/api/src/auth/rbac/capability.matrix.ts` — that file and this document must
stay in lockstep; changing one without the other is a defect.

Status: **IMPLEMENTED (R0, 2026-08-09).** The flat `GlobalRole` enum is gone;
`UserRole` is now `{ role: BaseRole, scope: RoleScope, tenantIds[] }`. The
authoritative matrix is pure code in `packages/domain/src/rbac/capability-matrix.ts`
(re-exported by `apps/api/src/auth/rbac/capability.matrix.ts`), enforced by
`CapabilityGuard` + `@RequireCapability`, and verified cell-by-cell in
`packages/domain/test/rbac.test.ts` (23 tests). Keep this file and that matrix in
lockstep. Note: one capability beyond the original spec table was added —
`fire_waitlist` (ADMIN + SUPERVISOR), per B10 ("an SPV is enough to approve").

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
| SPV | `SUPERVISOR` @ TENANT [one or more] | its branch(es) | its branch(es) |
| Supervisor (semua cabang) | `SUPERVISOR` @ ORGANIZATION | all branches | active branch only (see §4) |
| Staff | `STAFF` @ TENANT [one] | its branch | its branch |

There is no "finance manager": FINANCE at organization scope is **Super Finance**.
The organization-scoped supervisor was asked for one person on 2026-11-17 (PRD
go-live 2 §6.2); it is the same SUPERVISOR capabilities, reaching every branch.
Labels come from one function, `staffRoleLabel` in `packages/contracts/src/auth.ts`.

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
| Run + export reports (`run_reports`) | ✔ | ✔ | **—** | — |
| Read invoices, deposits, contracts (lists, no capability: any staff) | ✔ | ✔ | ✔ | ✔ |
| Manage users, pricing config | ✔ | — | — | — |
| Delete anything | ✔ | — | — | — |
| Fire waitlist (B10) | ✔ | — | ✔ | — |
| Read the WhatsApp inbox (`read_messages`, go-live §9.5) | ✔ | — | ✔ | ✔ |
| Request a booking cancellation / start-date change (`request_booking_change`, go-live 2 §4) | ✔ | — | ✔ | ✔ |
| Upload KYC documents for a walk-in (`upload_kyc_on_behalf`, go-live 2 §5.1) | ✔ | — | ✔ | ✔ |

**Supervisors do not see reports** (PRD go-live 2 §6.2, 2026-11-17 — the client
was told so): no Reports item in the console nav, and `/reports/*` including
every export answers 403. They keep read access to invoices and deposits, which
are gated on being staff, not on `run_reports`.

**Approving a booking change is not a matrix cell.** City Storage's rule mixes role
and scope, so it follows `Organization.approvalPolicy` (defaults, PRD go-live 2
§4.1): a **cancellation** is approved by an ADMIN at ORGANIZATION scope (Super
Admin) only; a **start-date change** by a SUPERVISOR or ADMIN of either scope who
covers the branch. The decider is never the requester. Implemented with the change
requests (§4), not here.

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

---

## 6. Organization-wide settings need an organization-scoped Admin (go-live, 2026-11-08)

Some screens change something every branch shares. Holding `manage_users` is not
enough for them: a branch Admin holds it too, and could repoint the whole
organization's WhatsApp number from one branch (PRD go-live G8). These check
`hasOrganizationScope` **and** `manage_users`, in the API, not just the console:

| Surface | Read | Change |
|---|---|---|
| Settings → Messaging (provider, auto-reply, pairing/unlinking, test send) | any staff | Super Admin only |
| Messaging pause (`/organization/messaging/pause`) | any staff (the red banner) | Super Admin only |
| Settings → Branch (legal entity, contacts, bank accounts, PKP, numbering, online payment) | any staff in scope | Super Admin only |
| Inventory → Import units (CSV) | — | Super Admin only |
| Settings → Users → Import CSV | — | `manage_users`; a branch Admin only into their own branch and never organization-wide roles |

Inbox (PRD go-live §9.5): `read_messages` — ADMIN, SUPERVISOR and STAFF; **not**
FINANCE. Branch-scoped as before. Open with the client (§16 Q6): confirm Finance
stays out. Matrix row in `packages/domain/src/rbac/capability-matrix.ts`, mirrored in
`apps/console/src/lib/capabilities.ts`.

## 7. Passwords (PRD go-live 2 §6.1, 2026-11-21)

Nobody sets or sees someone else's password.

| What | Who | How |
|---|---|---|
| Create a staff account | `manage_users` | No password field (`POST /users` refuses one). The account gets a single-use set-password link, 72 h: emailed when email is configured and messaging is not paused, otherwise shown once to the admin to hand over. |
| Reset someone's password ("Kirim tautan atur ulang") | `manage_users`; an organization-wide account only by a Super Admin | `POST /users/:id/reset-password`. The old password stops working at once, every session of the account is signed out, an earlier link is cancelled, a new link is issued as above. Not for your own account. |
| Change my password | any staff | User menu → Ganti kata sandi; `POST /auth/staff/change-password` with the current password. Every other session of the account is signed out; this one gets a fresh token. 5 wrong guesses at the current password in 15 minutes → 429. |
| Break-glass admin | operator | `PROMOTE_ADMIN_*` in `apps/api/start.sh`. Its password is one-time: it must be changed at first login. |

Policy (`checkPasswordPolicy`, `packages/contracts/src/password-policy.ts`, used by
the API and the console): at least 10 characters; not the person's email, its
local part or their name; not on a short list of common passwords (with trailing
digits/punctuation stripped: `password2026!` counts). No composition rules.

**Forced change.** `User.mustChangePassword`: set by the `20261121133000_passwords`
migration on every tenant account that already had a password (all of them were
typed by someone else), by an admin reset and by the break-glass path. While set,
login still succeeds, but **`JwtAuthGuard` refuses every route** except those
marked `@AllowPendingPasswordChange()` — `GET /auth/staff/me` and
`POST /auth/staff/change-password` — with 403 `PASSWORD_CHANGE_REQUIRED`;
`OptionalJwtAuthGuard` treats such a session as anonymous. The console routes to
`/account/password` on that code and after login.

**Session revocation.** Staff JWTs are checked against the account on every request
(`JwtStrategy`): a suspended account is refused at once, and a token issued before
`User.passwordChangedAt` is refused (401). The demo seed resets its accounts to
`mustChangePassword=false`; a production database is never seeded with users.

Document access (client page vault, PRD go-live §7.4): KYC files need
`approve_booking` or `approve_deposit_refund` (as before) and every open is
audited (`KYC_FILE_OPENED`); contracts, invoices and payment proofs are open to any
staff role in the branch.
