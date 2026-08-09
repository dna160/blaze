# RentOS — Infrastructure & Remediation Build Spec

| Field | Value |
|---|---|
| Version | 2.0 — supersedes `docs/PRD.md` where they conflict |
| Repo | `github.com/dna160/blaze` |
| Verified branch | `claude/rentos-platform-build-www4ou` (28 commits, HEAD at time of writing) |
| Client | City Storage (Mr. Maverick, Ko Yudi) |
| Vendor | Alexander — IT Solutions Company |
| Source of truth | Two client meeting transcripts (July 2026) |
| Status | **Blocking corrections identified. Do not start R1 until §7 decisions are closed.** |

---

## 1. How to read this document

`docs/PRD.md` in the repo was written **before** the client meetings. Five of its
foundational assumptions are wrong. The codebase built faithfully against those
assumptions across Phases 0–4, so the corrections are **schema-breaking**, not
cosmetic.

Precedence when documents disagree:

```
This spec  >  meeting transcripts  >  docs/PRD.md  >  docs/HANDOFF.md
```

`docs/HANDOFF.md` remains the living session log and must keep being updated at the
end of every work session. This spec defines *what to build*; HANDOFF records
*what got built*.

Terminology fixed for the rest of this document:

| Term | Means |
|---|---|
| **Organization** | City Storage as a business entity. New concept — does not exist in the current schema. |
| **Tenant** | One physical location/branch. Was previously `Location`. |
| **Rental Order** | A single month's rental. Was previously a recurring cycle of one `Booking`. |
| **Master Agreement** | The once-per-customer signed contract that Rental Orders reference. New concept. |

---

## 2. Verified current state of `blaze`

Confirmed by direct inspection of the repository, not inferred.

### 2.1 Stack and layout (as built)

```
blaze/
├── apps/
│   ├── api/          NestJS modular monolith  (:4000)
│   ├── worker/       BullMQ processors
│   ├── storefront/   Next.js customer surface (:3000)
│   └── console/      Next.js staff surface    (:3001)
├── packages/
│   ├── database/     Prisma schema + RLS migrations + seed
│   ├── domain/       Pure business logic, zero framework deps, 33 unit tests
│   ├── contracts/    Shared zod schemas — validation (API) + types (frontends)
│   └── config/       Shared tsconfig/eslint presets
├── infra/docker/     One Dockerfile per service (builder = DOCKERFILE, no Nixpacks)
├── docker-compose.yml
├── pnpm-workspace.yaml · turbo.json · .nvmrc (Node 22+) · pnpm 9.15.0
└── apps/*/railway.toml
```

API modules present: `agreements · api-keys · audit · auth · automation · booking ·
catalog · common · crm · deposits · external-api · finance · health · kyc ·
notifications · ota-sync · payments · platform · prisma · reporting · storage ·
swap-requests · tenancy · tenant-webhooks · webhook-dispatch`

Worker jobs present: `generate-recurring-invoices · dunning-ladder ·
ledger-balance-check · deliver-tenant-webhook · platform-billing · sync-ota-calendars`

`packages/domain/src`: `booking-model/ · billing/ · pricing/ · state-machine/ ·
money.ts`

`packages/database/src`: `tenant-context.ts · invoicing.ts · ledger.ts ·
invoice-number.ts · pooled-availability.ts · platform-billing.ts · ical.ts ·
ota-blocking.ts · platform-context.ts · client.ts`

### 2.2 What is genuinely done and should not be rebuilt

- **Tenant isolation.** `withTenantContext()` sets a Postgres session variable that
  RLS policies check; the app connects as non-owner role `rentos_app` so RLS cannot
  be bypassed by table ownership. No `where: { tenantId }` escape hatch exists.
  `TenantMatchGuard` rejects any mutating request whose JWT tenant disagrees with the
  resolved tenant. **This is the strongest part of the codebase. Preserve it.**
- **Double-entry ledger**, verified balanced live after invoice-issue, payment,
  deposit-hold, deposit-refund, and credit-note operations. Nightly balance-check job.
- **Maker-checker** on manual payments (recorder ≠ verifier, enforced 403).
- **Credit notes** with automatic replacement invoice for remaining balance.
- **Deposits**: hold, partial application, refund request/approve workflow.
- **Month-end close view** + invoice/payment/ledger CSV export, finance-roles-only.
- **Unit map + occupancy view** (console, staff-only).
- **Swap/upgrade requests** with computed mid-cycle proration.
- **KYC** upload, manual review queue, and automated verification provider seam.
- **Provider ports**: `PaymentProvider`, `MessagingProvider`, `ESignProvider`,
  `KycVerificationProvider`. Privy e-sign adapter is coded but unconfigured;
  `MockESignProvider` is the default.
- **Franchise-facing surface**: `TenantApiKey` (HMAC-signed), outbound webhook
  subscriptions + delivery tracking, `external-api` module.
- **`BookingModelStrategy`** seam proven by three live tenants on three booking
  models with zero application code changes.

### 2.3 Schema facts that drive the corrections

```prisma
model Tenant   { ... locations Location[] ... }   // ← one tenant owns many locations
model Location { tenantId ... assets Asset[] }    // ← location is a child row

enum GlobalRole { PLATFORM_ADMIN SUPER_ADMIN OPS_ADMIN FINANCE_ADMIN VIEWER }
model UserRole  { userId, role }                  // ← NO location scoping column

model Booking  { anchorDay Int?  endDate DateTime?  rateTier RateTier ... }
                                                  // ← indefinite lease + recurring cycles
enum RateTier  { DAILY WEEKLY MONTHLY }           // ← DAILY/WEEKLY exposed
model Contract { bookingId ... esignStatus ... }  // ← one contract per booking, no master
```

No `Organization`, `Waitlist`, `RenewalConfirmation`, or `MasterAgreement` model
exists anywhere in the 927-line schema.

---

## 3. The five breaking corrections

Each of these was stated by the client and contradicts what is built. They are
ordered by blast radius — do them in this order, because later ones depend on
earlier ones.

### C1 — Tenant is a location

**Client:** every branch is its own tenant; HO sees across them; franchisees must
not see each other.

**Built:** `Tenant → Location[]`. HO visibility would be a single tenant with many
child rows — the opposite shape.

**Correct model:**

```
Organization (City Storage)
  └── Tenant  (= one branch/location: Kebon Jeruk, ...)
        ├── AssetType, Asset, Booking, Invoice, Customer, ...
        └── Users scoped to this tenant
```

**Migration approach.** Do *not* delete `Location`. Introduce `Organization`, add
`Tenant.organizationId`, and backfill one Tenant per existing Location, moving
`Asset.locationId → Asset.tenantId`. Keep `Location` as a nullable descriptive row
(address, timezone) for one release, then drop it. This keeps every existing RLS
policy valid throughout — they key on `tenant_id`, which never changes meaning.

**RLS consequence — read carefully.** HO users need to read across tenants. That is
a deliberate, explicit hole in the isolation model that currently does not exist.
Implement it as a *separate* session variable (`app.organization_id`) with its own
policy clause, and **only for read paths**. Never widen the existing `app.tenant_id`
policy. Write paths stay single-tenant, always. A cross-tenant write bug in a
franchise system is unrecoverable commercially.

> Session 16 of the existing build already found and fixed one real cross-tenant
> leak at 2 tenants, re-verified at 3. Assume this change reintroduces that class
> of bug and budget test time accordingly.

### C2 — Six roles, expressed as role × scope

**Client roles:** super admin (all locations), admin (one), super finance (all),
finance (one), spv (one), staff (one).

**Built:** flat `GlobalRole` enum, no scope column.

**Do not add six enum values.** Split the two axes:

```prisma
enum BaseRole   { ADMIN FINANCE SUPERVISOR STAFF }
enum RoleScope  { ORGANIZATION TENANT }

model UserRole {
  userId    String
  role      BaseRole
  scope     RoleScope
  tenantIds String[]   // empty when scope = ORGANIZATION
}
```

| Client name | Encoding |
|---|---|
| Super Admin | `ADMIN` @ ORGANIZATION |
| Admin | `ADMIN` @ TENANT [one] |
| Super Finance | `FINANCE` @ ORGANIZATION |
| Finance | `FINANCE` @ TENANT [one] |
| SPV | `SUPERVISOR` @ TENANT [one] |
| Staff | `STAFF` @ TENANT [one] |

Capability matrix:

| | Admin | Finance | Supervisor | Staff |
|---|---|---|---|---|
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

`tenantIds` as an array (not a single nullable column) costs nothing now and avoids
a migration when someone covers two branches — a scenario Ko Yudi described.

The existing maker-checker guard already enforces recorder ≠ verifier and must be
preserved verbatim through this refactor.

### C3 — Monthly only

**Client:** minimum and maximum billing unit is one month. No daily rental. No
partial-month proration. Odd durations round to whole months.

**Built:** `RateTier { DAILY WEEKLY MONTHLY }`, plus proration math in
`packages/domain/src/pricing/` exercised by the swap-request flow.

**Action:** gate `DAILY`/`WEEKLY` behind a tenant feature flag defaulted **off**.
Do not delete the code — it is tested, and a future hotel/venue tenant needs it.
For City Storage, any code path that can produce a non-integer month count must
throw rather than round silently.

Proration survives in exactly one place: **swap requests** (mid-month unit change),
where the client explicitly wants a computed difference. Everywhere else it is dead
code for this tenant.

### C4 — Renewal is a new contract, gated on confirmation

**Client flow, verbatim from the meeting:**

```
H-14  system asks customer: renewing?
      ↓ customer confirms
      NEW contract generated  →  NEW invoice generated
      ↓
H-7 / H-5 / H-3 / H-1   payment reminders (to customer AND to admin)
      ↓
      paid → next month runs
```

**Built:** `generate-recurring-invoices.job.ts` materialises the next invoice at
`H-lead` with no confirmation gate, against one long-lived `Booking` with an
`anchorDay`. This is precisely the behaviour the client rejected — and precisely the
behaviour that made their old system's contracts unenforceable ("monthly, no end
date").

**Correct model.** Every month is a discrete, closed-ended agreement:

```prisma
model RentalOrder {
  masterAgreementId String     // ← signed once, at onboarding
  tenantId          String
  customerId        String
  assetId           String
  periodStart       DateTime   // real dates, both ends
  periodEnd         DateTime
  status            RentalOrderStatus
  previousOrderId   String?    // renewal chain
}

enum RentalOrderStatus {
  PENDING_APPROVAL  APPROVED  AWAITING_PAYMENT  ACTIVE
  RENEWAL_OFFERED  RENEWAL_CONFIRMED  RENEWAL_DECLINED
  EXPIRING  COMPLETED  DEFAULTED
}
```

The renewal job replaces the recurring-invoice job's trigger, not its billing math —
`packages/database/src/invoicing.ts` is reusable as-is once the trigger changes.

**Unresolved and blocking:** what happens at H-7 with no customer reply? Auto-decline
and release to waitlist, or escalate to a human call? This single rule gates the
entire waitlist mechanism (C5). See §7.

### C5 — Waitlist is an armed booking, not a queue

**Client:** when a unit is confirmed non-renewing, the waitlist entry
**auto-generates contract and invoice**.

**Built:** nothing. No waitlist concept exists.

You cannot auto-issue a contract to someone who never committed. Therefore a
waitlist entry must be captured as a **conditionally approved booking**: full
customer data, KYC submitted and reviewed, price snapshot frozen, terms accepted —
everything except an assigned unit and a date.

Three rules that must be in the first implementation, not retrofitted:

1. **Queue position.** First armed entry fires; others stay armed and shift up.
2. **Single-fire lock.** One released unit can fire exactly one entry. Take a row
   lock on the asset before firing — two waitlisters and one unit is a
   double-booking incident with a signed contract attached.
3. **Payment TTL.** If the fired invoice is unpaid within *N* hours (config,
   suggest 24), void it, mark the entry `EXPIRED`, and fire the next in queue.
   Without this, one non-paying waitlister freezes a unit indefinitely — the exact
   failure that made the client disable their old system's public availability.

```prisma
model WaitlistEntry {
  tenantId     String
  assetTypeId  String
  customerId   String
  position     Int
  status       WaitlistStatus  // ARMED FIRED EXPIRED CONVERTED CANCELLED
  priceSnapshot Json
  firedAt      DateTime?
  expiresAt    DateTime?
  @@unique([tenantId, assetTypeId, position])
}
```

---

## 4. Full delta register

Every requirement extracted from both transcripts, mapped to build state.
**S** = status: ✅ built · ⚠️ built but wrong · ❌ missing.

### 4.1 Identity & access

| # | Requirement | S | Action |
|---|---|---|---|
| 1 | WA number + OTP login, no passwords | ✅ | — |
| 2 | Google/Gmail OAuth fallback | ❌ | Firebase Auth or direct Google OAuth in `apps/api/src/auth` |
| 3 | Business account: multiple WA numbers → one customer entity | ❌ | `CustomerPhone` join table; add-number flow with OTP confirm in portal |
| 4 | Individual vs business registration, different fields | ❌ | `Customer.type` discriminator + conditional form schema in `packages/contracts` |
| 5 | KTP + address capture | ✅ | — |
| 6 | Six roles with location scope | ⚠️ | **C2** |
| 7 | Single login URL across branches, tenant switcher | ❌ | Console shell: org-scoped session, tenant picker |
| 8 | HO super-user cross-branch visibility | ❌ | **C1** — read-only org scope |
| 9 | Franchisee isolation from other branches | ✅ | RLS already guarantees this |

### 4.2 Booking & inventory

| # | Requirement | S | Action |
|---|---|---|---|
| 10 | Customer picks location → sees live availability + price | ✅ | — |
| 11 | **Customer must NOT choose the unit** — company assigns | ⚠️ | Remove unit selection from storefront; assign at approval. Client's reason: avoids stranded gaps between bookings, like cinema seat blocking |
| 12 | Request-to-book with reference code → approve/reject | ✅ | — |
| 13 | Monthly only, no daily | ⚠️ | **C3** |
| 14 | Renewal confirmation gate at H-14 | ❌ | **C4** |
| 15 | Waitlist auto-generates contract + invoice | ❌ | **C5** |
| 16 | Per-asset-type publish/hide on storefront | ❌ | `AssetType.isPublished`. Client disabled their entire old portal because availability lied — this is the control that lets them launch cautiously |
| 17 | Show occupied until non-renewal is confirmed | ❌ | Availability query must treat `ACTIVE` + `RENEWAL_OFFERED` as unavailable |
| 18 | Swap / upgrade / downsize | ✅ | — |
| 19 | Check-in / check-out status | ✅ | — |
| 20 | Asset Type → Inventory hierarchy | ✅ | — |

### 4.3 Contracts & signature

| # | Requirement | S | Action |
|---|---|---|---|
| 21 | Contract with real end date every period | ⚠️ | **C4** |
| 22 | B2B requires signed contract, not invoice T&Cs | ❌ | Master Agreement model — §5 |
| 23 | E-sign via link, auto-generated on approval | ⚠️ | Port exists; Privy adapter unconfigured; `MockESignProvider` is default |
| 24 | Master agreement + monthly order addendum | ❌ | **Cost-critical — §5** |
| 25 | e-Meterai on documents above Rp 5,000,000 | ❌ | Provider API; confirm client's current practice first |

### 4.4 Finance

| # | Requirement | S | Action |
|---|---|---|---|
| 26 | Auto invoice on confirmation | ⚠️ | Retrigger per **C4** |
| 27 | Bank transfer + credit card only. **No VA, no PayPal** | ⚠️ | Xendit adapter exists; restrict methods per tenant config |
| 28 | Auto-reconciliation | ⚠️ | **Only works for card/QRIS.** Bank transfer has no callback — see §6 risk |
| 29 | Manual payment + proof upload + maker-checker | ✅ | — |
| 30 | Bundle discount by unit count | ❌ | `packages/domain/src/pricing/` |
| 31 | Duration-tier discount (6/12/24 months) | ❌ | Same module |
| 32 | Manual per-booking price override | ❌ | Client's real rates are 4.5% / 5% / 6% then hand-rounded. Rules alone will not cover it |
| 33 | Void / cancel invoice, SPV-gated | ⚠️ | Credit notes exist; explicit void + role gate needed |
| 34 | Backdate contract / shift period, SPV-gated | ❌ | Must void the superseded invoice — client named invoice pile-up as a live pain |
| 35 | Deposit hold / apply / refund | ✅ | — |
| 36 | Double-entry ledger | ✅ | — |
| 37 | Bulk export invoices + contracts by month | ⚠️ | CSV export exists; add contract PDF bundle |
| 38 | AR aging, occupancy, MRR | ✅ | — |

### 4.5 Communications

| # | Requirement | S | Action |
|---|---|---|---|
| 39 | WhatsApp Business API, client's own Meta account | ⚠️ | Port exists, unconfigured. **Needs Meta business verification: NPWP/NIB, one working session + ~2 days wait** |
| 40 | **One WA number for ALL branches**, no-reply | ❌ | Conflicts with per-tenant credential design. Move `MessagingProvider` credentials to Organization level |
| 41 | Reminders H-7 / H-5 / H-3 / H-1 | ⚠️ | Dunning ladder exists; re-tune steps |
| 42 | Reminders to **admin as well as customer** | ❌ | Second recipient channel on each ladder step |
| 43 | Renewal prompt H-14 | ❌ | **C4** |

### 4.6 Platform & operations

| # | Requirement | S | Action |
|---|---|---|---|
| 44 | Multi-tenant, unlimited tenants + users | ✅ | See §8 commercial warning |
| 45 | Branch onboarding wizard, starts empty | ❌ | Console flow; self-serve signup from Phase 4 is a partial base |
| 46 | Open API + per-tenant token for franchisee ERP | ✅ | `TenantApiKey` + `external-api` |
| 47 | Calendar / forward-occupancy view ("what's empty next month") | ❌ | Client called this their favourite screen in the old system |
| 48 | Dashboard: occupancy, revenue, unit status | ✅ | — |
| 49 | Mobile-weighted UI, one-pager storefront | ❌ | References given: Bluebird, Notebook, SpaceHub (book → map → unit) |
| 50 | Backup of front and back end | ❌ | **Client asked directly and received no answer.** Railway Postgres PITR + nightly logical dump to object storage, documented RTO/RPO |
| 51 | Railway security assurance | ❌ | Client said they would verify independently. Prepare a one-page brief |
| 52 | Website revamp | — | **Separate quotation, separate staff.** Keep out of this scope |

---

## 5. The e-signature cost architecture

City Storage issues a new contract **every month per customer**. At 100 occupied
units that is ~1,200 certified signatures per year, scaling linearly with occupancy
*and* with every new branch. Certified e-signatures are priced per signature. Built
naively, this is a recurring cost that grows with the client's success and gets
charged back to them monthly — a bad number to hand a client in month three.

**Structure to build instead:**

```
Onboarding (once per customer)
  └── Master Rental Agreement
        · certified PSrE signature
        · e-Meterai if document value > Rp 5,000,000
        · contains ALL enforceable terms

Every month (per rental period)
  └── Rental Order  →  references the master
        · WhatsApp OTP acceptance, or one-tap click-to-accept
        · logged: timestamp, IP, device, OTP proof
        · NO certified signature consumed
```

`UU ITE` Article 11 requires that signature creation data relate only to the
signatory and stay under their sole control during signing. An OTP-verified
acceptance, made against an identity already certified under the master agreement,
carries real evidentiary weight for the *order* — while the master carries the
enforceable terms. Roughly 90% reduction in certified-signature spend.

**Provider:** Mekari Sign primary (API-first, e-Meterai API, signers need no
account, sandbox available). Privy as fallback — larger installed base, so many B2B
counterparties already hold a Privy ID and sign in one tap. The repo's existing
`ESignProvider` port means this is an adapter swap, not a refactor.

**Must be lawyer-confirmed before build.** If the client's B2B counterparties reject
order-level acceptance, fall back to certified signature per order and reprice the
running cost line item. Do not discover this in month two.

---

## 6. Target file tree

Legend: **[+]** new · **[~]** modified · unmarked = exists, unchanged.

```
blaze/
├── apps/
│   ├── api/src/
│   │   ├── organization/                    [+]  org CRUD, tenant switcher, HO read scope
│   │   │   ├── organization.module.ts       [+]
│   │   │   ├── organization.service.ts      [+]
│   │   │   └── org-scope.guard.ts           [+]  read-only cross-tenant guard
│   │   ├── auth/
│   │   │   ├── otp/                              existing WA OTP
│   │   │   ├── google-oauth.strategy.ts     [+]  C-req #2
│   │   │   └── rbac/
│   │   │       ├── base-role.guard.ts       [~]  role × scope (C2)
│   │   │       └── capability.matrix.ts     [+]  §3 C2 table, single source
│   │   ├── booking/
│   │   │   ├── booking.service.ts           [~]  unit assignment moves to approval
│   │   │   ├── rental-order.service.ts      [+]  C4 — discrete monthly orders
│   │   │   └── renewal.service.ts           [+]  C4 — H-14 offer/confirm/decline
│   │   ├── waitlist/                        [+]  C5
│   │   │   ├── waitlist.module.ts           [+]
│   │   │   ├── waitlist.service.ts          [+]  arm / position / fire
│   │   │   └── waitlist-fire.guard.ts       [+]  single-fire row lock
│   │   ├── agreements/
│   │   │   ├── master-agreement.service.ts  [+]  §5
│   │   │   ├── order-acceptance.service.ts  [+]  §5 OTP acceptance record
│   │   │   └── providers/
│   │   │       ├── mekari-sign.adapter.ts   [+]  primary
│   │   │       ├── privy.adapter.ts              exists, unconfigured
│   │   │       └── mock.provider.ts              default until keys land
│   │   ├── catalog/
│   │   │   └── availability.service.ts      [~]  publish/hide + renewal-aware (#16,#17)
│   │   ├── finance/
│   │   │   ├── invoice-void.service.ts      [+]  #33 SPV-gated
│   │   │   ├── backdate.service.ts          [+]  #34 supersede + void
│   │   │   ├── price-override.service.ts    [+]  #32 audit-logged
│   │   │   └── bulk-export.service.ts       [~]  #37 + contract PDF bundle
│   │   ├── notifications/
│   │   │   └── recipients.resolver.ts       [+]  #42 customer + admin fan-out
│   │   ├── reporting/
│   │   │   └── forward-occupancy.service.ts [+]  #47 calendar view
│   │   ├── payments/                             restrict methods per tenant (#27)
│   │   ├── crm/ · kyc/ · deposits/ · swap-requests/ · audit/
│   │   ├── external-api/ · api-keys/ · tenant-webhooks/ · webhook-dispatch/
│   │   ├── tenancy/ · platform/ · ota-sync/ · automation/ · storage/ · health/
│   │   └── common/ · prisma/ · app.module.ts · main.ts
│   │
│   ├── worker/src/jobs/
│   │   ├── generate-recurring-invoices.job.ts [~] retrigger from renewal confirm
│   │   ├── renewal-offer.job.ts             [+]  H-14 prompt
│   │   ├── renewal-timeout.job.ts           [+]  no-reply rule — BLOCKED, see §7
│   │   ├── waitlist-fire.job.ts             [+]  on release → contract + invoice
│   │   ├── waitlist-expiry.job.ts           [+]  payment TTL → next in queue
│   │   ├── dunning-ladder.job.ts            [~]  H-7/5/3/1, dual recipient
│   │   ├── backup-verify.job.ts             [+]  #50 nightly restore assertion
│   │   └── ledger-balance-check.job.ts · deliver-tenant-webhook.job.ts
│   │       platform-billing.job.ts · sync-ota-calendars.job.ts
│   │
│   ├── storefront/                          [~]  mobile-first rework (#49)
│   │   └── app/
│   │       ├── (catalog)/                   [~]  remove unit selection (#11)
│   │       ├── book/                        [~]  individual vs business form (#4)
│   │       ├── waitlist/                    [+]  join queue, full data capture
│   │       └── portal/
│   │           ├── renewals/                [+]  confirm / decline (C4)
│   │           ├── agreements/              [+]  master + order history
│   │           ├── team/                    [+]  business: add WA number (#3)
│   │           └── invoices/                     exists
│   │
│   └── console/
│       └── app/
│           ├── (shell)/tenant-switcher.tsx  [+]  #7
│           ├── calendar/                    [+]  #47 forward occupancy
│           ├── waitlist/                    [+]  queue management
│           ├── renewals/                    [+]  confirmation pipeline
│           ├── invoices/                    [~]  void + backdate (#33,#34)
│           ├── settings/users/              [~]  role × scope assignment (C2)
│           ├── settings/onboarding/         [+]  #45 branch wizard
│           └── approvals/ · inventory/ · unit-map/ · reports/ · month-end/
│
├── packages/
│   ├── database/
│   │   ├── prisma/
│   │   │   ├── schema.prisma                [~]  see §3 for every model change
│   │   │   ├── migrations/
│   │   │   │   ├── *_add_organization/      [+]  C1
│   │   │   │   ├── *_org_read_rls/          [+]  C1 — separate session var
│   │   │   │   ├── *_role_scope/            [+]  C2
│   │   │   │   ├── *_rental_orders/         [+]  C4
│   │   │   │   ├── *_waitlist/              [+]  C5
│   │   │   │   └── *_master_agreements/     [+]  §5
│   │   │   └── seed.ts                      [~]  City Storage org + branches
│   │   └── src/
│   │       ├── tenant-context.ts                 DO NOT WEAKEN
│   │       ├── org-context.ts               [+]  read-only org scope
│   │       ├── invoicing.ts                 [~]  order-based, not cycle-based
│   │       └── ledger.ts · invoice-number.ts · pooled-availability.ts · ...
│   │
│   ├── domain/src/
│   │   ├── booking-model/
│   │   │   └── recurring-lease.strategy.ts  [~]  monthly-only guard (C3)
│   │   ├── rental-order/                    [+]  C4 state machine
│   │   ├── waitlist/                        [+]  C5 queue + fire rules
│   │   ├── pricing/
│   │   │   ├── bundle-discount.ts           [+]  #30
│   │   │   ├── duration-discount.ts         [+]  #31
│   │   │   └── override.ts                  [+]  #32
│   │   └── state-machine/ · billing/ · money.ts
│   │
│   ├── contracts/src/                       [~]  zod schemas for all new DTOs
│   └── config/
│
├── infra/
│   ├── docker/                                   4 Dockerfiles, builder=DOCKERFILE
│   └── backup/                              [+]  #50 dump + restore-verify scripts
│
└── docs/
    ├── PRD.md                                    superseded where conflicting
    ├── HANDOFF.md                           [~]  update every session
    ├── BUILD-SPEC.md                        [+]  this document
    ├── RBAC.md                              [+]  C2 matrix, authoritative
    ├── LEGAL-ESIGN.md                       [+]  §5 + lawyer sign-off record
    └── RUNBOOK-BACKUP.md                    [+]  #50 RTO/RPO, restore drill
```

---

## 7. Blocking decisions

Build cannot start on the dependent items until these are answered. Owner column is
who must answer, not who asks.

| # | Question | Owner | Blocks |
|---|---|---|---|
| B1 | No customer reply by H-7 on a renewal offer — auto-decline and release to waitlist, or escalate to a human call? | Maverick | C4, C5, `renewal-timeout.job.ts` |
| B2 | Does HO see full financials on franchised branches, or aggregate only? Franchisees may object once they understand. | Ko Yudi | C1 RLS policy shape |
| B3 | Will B2B counterparties accept order-level OTP acceptance under a signed master agreement? | Client's lawyer | §5, all e-sign cost |
| B4 | Is City Storage PKP? | Ko Yudi | Invoice tax lines |
| B5 | Deposit: fixed nominal or multiple of monthly rent? Refund SLA? | Maverick | Deposit config |
| B6 | Face-scan KYC in scope? Third-party paid. Driven by the police incident, so this is liability protection, not a feature. | Maverick | KYC provider contract |
| B7 | Records to migrate from Booqable, and cutover date? | Ko Yudi | Migration scripting |
| B8 | Number of locations and units at launch? | Ko Yudi | Seed, capacity, pricing |
| B9 | Do they affix e-Meterai on contracts today? | Ko Yudi | §5 compliance scope |
| B10 | Who holds final approval authority, and what working hours drive the SLA clock? | Maverick | Approval routing |

---

## 8. Phased plan with handoff gates

Phases are named `R*` (remediation) to avoid collision with the PRD's Phase 0–4,
which are already marked complete in `HANDOFF.md`.

Every phase ends with a **handoff gate**. A gate is not "code merged" — it is a
demonstrated behaviour against real Postgres/Redis, recorded in `docs/HANDOFF.md`
with the same evidence discipline the existing sessions used (the ledger-balance
verification is the standard to match).

### R0 — Foundation corrections

**Scaffold**

```bash
git checkout -b remediation/r0-foundation
pnpm --filter @rentos/database exec prisma migrate dev --name add_organization
pnpm --filter @rentos/database exec prisma migrate dev --name org_read_rls
pnpm --filter @rentos/database exec prisma migrate dev --name role_scope
```

**Work:** C1 (Organization → Tenant, `Asset.locationId → tenantId`, org read-scope
RLS as a separate session variable) · C2 (role × scope, capability matrix,
console user-assignment UI) · tenant switcher · single login URL.

**Gate R0 — must all pass:**
- [ ] Two branches seeded as separate tenants. Branch admin at Kebon Jeruk queries
      the other branch's bookings → **zero rows**, not an error, not a leak.
- [ ] Super Admin reads both branches. Super Admin attempts a **write** to a
      non-active tenant → rejected.
- [ ] Every one of the six client roles instantiated; capability matrix verified
      cell by cell, including the four denials that matter (staff cannot void,
      supervisor cannot verify payment, finance cannot delete, admin-scope-tenant
      cannot see sibling branch).
- [ ] Existing maker-checker 403 still fires after the RBAC refactor.
- [ ] All 33 existing domain tests green.

> **Do not proceed to R1 with a red R0 gate.** Every later phase writes rows that
> inherit this tenancy shape; a defect here is a data migration later.

### R1 — Rental lifecycle correction

**Scaffold**

```bash
git checkout -b remediation/r1-lifecycle
mkdir -p packages/domain/src/rental-order packages/domain/src/waitlist
mkdir -p apps/api/src/waitlist
pnpm --filter @rentos/database exec prisma migrate dev --name rental_orders
pnpm --filter @rentos/database exec prisma migrate dev --name waitlist
```

**Work:** C4 (RentalOrder + renewal offer/confirm/decline, retrigger invoicing) ·
C5 (waitlist arm/position/fire/expire) · C3 (monthly-only guard) · availability
publish-hide and renewal-aware query (#16, #17) · unit assignment moved to approval
(#11).

**Prerequisite:** B1 answered. `renewal-timeout.job.ts` cannot be written without it.

**Gate R1:**
- [ ] Full month-to-month chain: order → H-14 offer → confirm → new contract +
      invoice → H-7/5/3/1 reminders to customer **and** admin → payment → next
      period. Run twice consecutively to prove the chain links.
- [ ] Decline path: customer declines → unit released → waitlist fires → contract
      and invoice auto-generated for the waitlister.
- [ ] **Single-fire proof:** two armed waitlisters, one released unit, concurrent
      fire attempts → exactly one contract exists. Run under real concurrency, not
      sequentially.
- [ ] Payment TTL: fired invoice unpaid past TTL → voided, entry `EXPIRED`, next in
      queue fires.
- [ ] Availability never shows a unit as free while its current order is `ACTIVE`
      or `RENEWAL_OFFERED`.
- [ ] Any attempt to price a non-integer month count throws.

### R2 — Contracts, signature, finance controls

**Scaffold**

```bash
git checkout -b remediation/r2-agreements
pnpm --filter @rentos/database exec prisma migrate dev --name master_agreements
pnpm add @mekari/sign-sdk --filter @rentos/api   # or REST client if no official SDK
```

**Work:** §5 master agreement + order acceptance · Mekari Sign adapter behind the
existing `ESignProvider` port · e-Meterai (pending B9) · invoice void (#33) ·
backdate with supersede (#34) · manual price override (#32) · bundle and duration
discounts (#30, #31) · bulk export with contract bundle (#37).

**Prerequisite:** B3 answered by the client's lawyer. Ship `MockESignProvider` as
default until it is.

**Gate R2:**
- [ ] Master agreement signed once via Mekari sandbox; three subsequent monthly
      orders accepted by OTP with **zero** additional certified signatures consumed.
- [ ] Acceptance record contains timestamp, IP, device, OTP proof — exportable as
      an evidence bundle.
- [ ] Backdate: invoice shifted one week → original voided, replacement issued, no
      pile-up, ledger still balanced.
- [ ] SPV can void; staff receives 403.
- [ ] Bundle (2 units) + duration (12 months) + manual override compose in the
      correct order and produce the hand-rounded figure the client actually quotes.
- [ ] Ledger balanced after every operation above.

### R3 — Communications, reporting, operations

**Scaffold**

```bash
git checkout -b remediation/r3-ops
mkdir -p infra/backup apps/console/app/calendar
```

**Work:** WhatsApp Business API live on the client's Meta account (#39) ·
org-level single WA number (#40) · dual-recipient reminders (#42) · forward-occupancy
calendar (#47) · branch onboarding wizard (#45) · backup + restore drill (#50) ·
Railway security brief (#51) · Google OAuth (#2) · business multi-number (#3) ·
individual/business forms (#4).

**Client dependency:** Meta business verification needs NPWP/NIB, one working
session with the client, and roughly two days of waiting. **Schedule this in R0, not
R3** — it is the longest-lead external dependency in the project and it is not on
your critical path to start early.

**Gate R3:**
- [ ] Real WhatsApp message delivered from the client's verified number, one number
      serving two branches, replies suppressed.
- [ ] Reminder fires to customer and admin at each of H-7/5/3/1.
- [ ] Calendar answers "which units are empty next month" correctly against seeded
      renewal states.
- [ ] New branch provisioned start-to-finish through the wizard by a non-engineer.
- [ ] **Backup restored into a scratch database and queried.** A backup that has
      never been restored is not a backup.

### R4 — UI rework and launch readiness

**Work:** mobile-first storefront (#49) · console polish · migration from Booqable
(B7) · staff training · cutover.

**Gate R4:**
- [ ] Full journey on a mid-range Android over 4G: discover → book → approve →
      pay → occupy, under target LCP.
- [ ] Booqable records migrated, spot-checked against source.
- [ ] Staff complete a live booking unaided after training.
- [ ] Rollback plan written and rehearsed.

---

## 9. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Bank transfer cannot auto-reconcile.** No callback exists. The client's dominant B2B method is exactly the one that cannot be automated, while "everything is automated" is what was sold. | **High** | Resolve before R2. Either sell them on VA (they resisted on fees — quantify the actual per-transaction cost against staff hours saved) or build a manual matching screen and reset the expectation in writing now. |
| Org read-scope reintroduces cross-tenant leakage | High | Separate session variable, read paths only, negative tests at 3+ tenants (Session 16 already found one such bug once) |
| Waitlist double-fire produces two signed contracts for one unit | High | Row lock + concurrent test in Gate R1, not a sequential one |
| Lawyer rejects order-level acceptance | Medium | `MockESignProvider` default until B3; reprice running cost if rejected |
| Meta verification delays launch | Medium | Start in R0 |
| Client staff bypass the system, keep using spreadsheets | Medium | Payment links only generatable in-platform; approval only in-platform; owner dashboard creates top-down pull |
| Docker/Railway stack never validated end-to-end | Medium | `HANDOFF.md` states the full Docker stack was **not verified** in the sandbox it was built in (registry access was blocked). Validate before R3 gate |
| Scope creep from website revamp | Medium | Separate quotation, separate staff, separate timeline |

---

## 10. Commercial reconciliation — resolve before sending anything further

Four gaps between what was said in the room and what the quotation says:

| | Verbal (meeting) | Quotation ALX-2026-07-001 |
|---|---|---|
| Price | **55** including website revamp, DP 27.5 | 50, website excluded |
| Timeline | "one month", prototype in 2 weeks | 10–12 weeks |
| Maintenance | waved off — "udahlah, gampang" | free month, then paid annual |
| Feedback cadence | weekly / bi-weekly for a month | not mentioned |

The **timeline gap is the dangerous one.** One month was said twice, and a two-week
prototype was committed to. Whichever number is true, the client will hold you to
the verbal one. Reconcile it in writing before kickoff, not at week five.

Two further items:

**Unlimited tenants and unlimited users was promised verbally.** City Storage
franchises. Every future branch and every franchisee is now a free tenant, forever.
That single sentence forecloses the per-branch licensing revenue that the PRD's
Phase 4 gate was designed to capture. If it was not intended, correct it now —
after signature it is not negotiable.

**Scope defence if the client tries to strip a 10M module:** the WhatsApp reminder
ladder and payment auto-reconciliation are precisely what solve their collections
problem. Core System alone is a catalogue, not a cash machine.

---

## 11. Session discipline

Carried forward from the existing `HANDOFF.md`, which is the reason this codebase
survived 26 sessions of context resets:

1. Read `docs/HANDOFF.md` before touching anything.
2. Update it at the **end** of every session — decisions made, what is proven, what
   is not.
3. Never claim a gate passed without recorded evidence. The existing standard is
   `SELECT entry_type, sum(amount) FROM ledger_entries GROUP BY entry_type` returning
   identical DEBIT/CREDIT totals after every operation. Match that bar.
4. Never weaken `withTenantContext()`. There is no `where: { tenantId }` escape
   hatch in this codebase and there must never be one — forgetting tenant scope is
   structurally a zero-rows result, never a cross-tenant leak. That property is
   worth more than any feature in this document.

---

*End of spec. Highest-priority unblocking actions: B1 (renewal no-reply rule),
B3 (lawyer on order-level acceptance), the bank-transfer reconciliation decision,
and Meta business verification — start that one this week regardless of everything
else.*
