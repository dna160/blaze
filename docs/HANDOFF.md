# RentOS — Build Handoff

**Read this before touching the codebase.** This is the living memory across
sessions — Sonnet 5 keeps building this platform over multiple future
sessions/context resets, and this file is how a fresh session picks up
without re-deriving decisions already made. Update it at the end of every
session, before handoff, not just this one.

Source PRD: [`docs/PRD.md`](./PRD.md). Section references below (`§X`) are PRD sections.

---

## Phase status (PRD §13)

| Phase | Scope | Status |
|---|---|---|
| **0 — Foundation** | Tenancy + RLS, auth/RBAC, domain model, asset registry, Xendit/WA sandbox | ✅ Done (auth: staff JWT + customer OTP; RLS verified; provider seams in place, sandbox keys not yet supplied) |
| **1 — Storage MVP** | Storefront, approval workbench, RECURRING_LEASE engine, invoicing+webhooks, dunning, customer portal, P0 reports | ✅ Core loop done and verified end-to-end (see "What's proven" below), including the customer-facing pay-now flow (added Session 3). 🚧 Gaps: KYC upload UI, contract e-sign gate, request-info/customer-reply UI, unit reassignment on approve UI |
| **2 — Finance depth & automation** | Deposit payouts, refunds, credit notes, maker-checker, unit map, swap requests, e-sign, accounting export, month-end view | 🚧 In progress. ✅ Done: double-entry ledger (accrual basis, verified balanced live), manual payment recording + maker-checker verification (now with console UI), deposit refund request/approve workflow (now with console UI), credit note issuance (now with console UI), nightly ledger-balance-check worker job. ⬜ Still missing: unit map, swap requests, e-sign, accounting export, month-end view, partial deposit application against damages |
| **3 — Multi-vertical proof** | NIGHTLY + DURATION_ORDER real logic, pooled inventory, seasonal pricing, second tenant | ⬜ Not started. `BookingModelStrategy` seam exists and is proven (typed stubs for NIGHTLY/DURATION_ORDER/HOURLY_SLOT throw `BookingModelNotImplementedError`) — Phase 3 is implementing their real math, not inventing the seam |
| **4 — SaaS-ready** | Self-serve tenant signup, tenant billing, visual automation builder, OTA sync, KYC automation | ⬜ Not started, deliberately deferred per PRD |

### What's proven end-to-end (verified live against local Postgres/Redis)

**Session 1:** Catalog browse → booking submit (soft-reserve TTL) → console
approval → invoice generation (proration + PPN 11% + deposit line, correct
to the rupiah) → OTP login → mock payment → booking ACTIVE → asset
OCCUPIED → deposit HELD → occupancy report → give-notice → final
settlement invoice. Both `apps/worker` jobs (recurring invoice generator,
dunning ladder) ran clean against real RLS-scoped data.

**Session 2 (finance depth):** Manual payment recorded by one staff user
(`OPS_ADMIN`) → same user blocked from verifying their own recording (403,
maker-checker) → different staff user (`FINANCE_ADMIN`) verifies →
booking activates. Deposit refund requested by ops → approval blocked for
`OPS_ADMIN` (403) → approved by `FINANCE_ADMIN` → mock payout ref
generated. Credit note issued against an unpaid invoice → invoice
transitions to `CREDITED`. **Ledger balance verified after every single
step**: `SELECT entry_type, sum(amount) FROM ledger_entries GROUP BY
entry_type` returned identical DEBIT/CREDIT totals (4,202,725.81 =
4,202,725.81) after invoice-issue, payment, deposit-hold, deposit-refund,
and credit-note entries all landed. The `ledger-balance-check` worker job
independently confirmed `balanced: true` reading the same data.

**Session 3 (finance UI + pay-now):** Built the UI the backend had been
missing. `apps/storefront/portal/invoices/[id]` — payment method selector
→ `POST /payments/initiate`; this was a real gap, not just missing
polish: before this, a customer could never actually pay through the app,
only via direct API calls in earlier verification. `apps/console/invoices/[id]`
— payment list with role-and-maker-checker-aware Verify button, manual
payment recording form, credit note list + issue form. `apps/console/deposits`
— full refund queue with status-and-role-gated action buttons. Added
`GET /deposits` (list-all, filterable by status) to support the queue view.
All new pages verified rendering (200, correct shell content) against the
live API; response shapes cross-checked against frontend types by hand.

**Found and fixed a real bug in `turbo.json`** while doing this: the
`typecheck` task only declared `dependsOn: ["^build"]` (upstream packages),
not its own `build` — harmless for NestJS/library packages, but Next.js's
`tsconfig.json` includes `.next/types/**/*.ts`, which only exists after
*that app's own* `next build` runs. Depending on task scheduling order,
`turbo run typecheck build` could typecheck against a stale or missing
`.next/types` and fail with `TS6053: File ... not found` — reproduced
this exact failure once. Fixed by adding `"build"` to typecheck's
`dependsOn` alongside `"^build"`.

33 unit tests in `packages/domain` cover the state machines and
proration/tax math. All 4 apps + 3 packages typecheck, build, and pass
`turbo run typecheck test build` clean (verified with `--force` after the
turbo.json fix, to rule out stale-cache false positives).

### What's explicitly NOT done (don't assume it exists)

- KYC document upload flow (schema + `SubmitKycDocumentRequestSchema` exist; no storefront UI, no S3-compatible storage wired up — `KycDocument.storageKey` has nowhere real to point yet)
- Contract e-signature / wet-sign PDF upload (schema exists; `contractRequired` is hardcoded `false` in `BookingService.handleInvoicePaid` — see "Known shortcuts" below)
- Per-tenant `AutomationSetting` rows are schema-only — `apps/worker`'s dunning ladder hardcodes the H-7/H-3/H-0/D+1/D+3/D+7/D+14 steps uniformly, doesn't read tenant config
- Partial deposit application against damages (`Deposit.appliedAmount` / `PARTIALLY_APPLIED` / `APPLIED` states exist in schema, unused — v1 refund workflow only handles the full-amount HELD → REFUND_REQUESTED → REFUNDED path)
- Automatic replacement invoice after a credit note (PRD: "superseded by CREDIT_NOTE + new invoice") — v1 marks the original invoice CREDITED and stops there; issuing the corrected replacement invoice is a manual follow-up action, not automatic
- Invoice-payment refunds (as opposed to deposit refunds) — no endpoint; `PaymentProvider.refund()` is only called from the deposit-refund flow today
- Proof-of-payment upload for manual payments is a plain text URL field (`proofUrl`) in the console form — no actual file upload widget or object storage integration, same gap as KYC documents (see above). Staff paste a reference/URL by hand.
- Unit map (visual grid) — list view only (P1 in PRD anyway)
- Swap/upgrade requests, promo codes, duration discounts — schema exists, zero application logic
- Platform admin console (multi-tenant switcher, tenant provisioning wizard) — out of scope until Phase 4; today, provisioning a tenant means writing rows directly (see `packages/database/prisma/seed.ts` as the template)
- Real Xendit/WhatsApp Cloud credentials — adapters are coded against the real APIs but unconfigured; `PAYMENT_PROVIDER=mock` / `MESSAGING_PROVIDER=console_log` is what actually runs today
- **Docker builds were never actually executed in this sandbox** — Docker Hub registry access is blocked by this environment's egress policy (confirmed via repeated 403s on `production.cloudfront.docker.com`, same class of block as `backboard.railway.com`). The Dockerfiles follow standard, well-established patterns (Turborepo `prune --docker`, Next.js `output: standalone`) and `turbo prune` itself was verified working locally, but nobody has run `docker build` or `docker compose up` against them. **Validate this first** in any environment with real registry access before trusting it blindly.

---

## Resume here

Refunds/credit-notes/maker-checker/ledger (Session 2) and their console +
storefront UI, plus the storefront pay-now flow (Session 3), are all done.
Next highest-leverage chunks, in rough priority order:

1. **KYC upload flow** (storefront upload UI + object storage integration
   + console review queue) — this is the last major P0 gap from PRD §7.1.2
   with zero UI today, and it blocks the "auto-approve if KYC verified"
   approval policy from ever being meaningfully exercised.
2. Real file/object storage for proof-of-payment and KYC documents — both
   currently take a raw text URL with no actual upload widget or backing
   storage. One S3-compatible integration would unblock both.
3. Automatic replacement invoice after a credit note (see "What's
   explicitly NOT done").
4. Work down PRD §13 Phase 2's remaining items: unit map, swap requests,
   e-sign, accounting export, month-end view.

Before writing new code:
1. `docker compose up` (or run each service manually per README "Local development") in an environment with real network access, to confirm the Dockerfiles actually work — this is unverified debt, still outstanding from Session 1.
2. Re-read "Known shortcuts" below so you don't accidentally treat a deliberate simplification as a bug to "fix" without understanding why it's there.

---

## Architectural decisions log

- **Hand-rolled FSM over xstate** (`packages/domain/src/state-machine/fsm.ts`): the PRD's guard rails (Booking `APPROVED → ACTIVE` requires three conditions checked atomically) need async guards reading live DB state. A plain async-predicate FSM fit that more directly than xstate's actor model, without the dependency weight of features (parallel states, spawned actors, visualizer) this codebase doesn't use.
- **RLS enforcement via a separate `rentos_app` role, not the migrating role** (`packages/database/prisma/migrations/*_enable_rls/migration.sql`): Postgres RLS does not apply to a table's owner by default. `FORCE ROW LEVEL SECURITY` closes that hole for `rentos_app` (no `BYPASSRLS`), while the migrating role gets `BYPASSRLS` explicitly (not assumed via superuser status, which managed Postgres providers often don't grant). Two connection strings: `DATABASE_URL` (migrations/seed only) and `DATABASE_URL_APP` (everything the running services do). Verified live: cross-tenant reads return zero rows, no-tenant-context reads return zero rows (fail-closed), migrator role sees everything.
- **`tenants` and `tenant_domains` are excluded from RLS**, deliberately. Resolving which tenant a request belongs to is the bootstrapping step that happens *before* `app.tenant_id` can be set — a table that needed tenant context to discover the tenant would be a chicken-and-egg lock-out. This is not a leak: which tenant owns which domain is inherently public (it's a live storefront domain).
- **Tenant resolution across services**: `apps/storefront` and `apps/console` are separate Railway services from `apps/api` — the browser calls the API's own domain directly, so the API never sees the tenant's real storefront/console Host. Each Next.js app resolves its own tenant from *its* Host (`apps/storefront/src/lib/tenant.ts`), then forwards it explicitly via `X-Tenant-Slug` on every API call. The API's `TenantMiddleware` honors that header in every environment (not gated to dev) — this is safe because every *mutating* route requires a JWT, and `TenantMatchGuard` rejects any request where the session's `tenantId` disagrees with the header. The header can only ever influence which tenant's *public* catalog an unauthenticated request browses, which is intentionally public (PRD §7.1.1).
- **`@rentos/database` depends on `@rentos/domain`** (not the reverse), and owns the shared invoice-generation orchestration (`packages/database/src/invoicing.ts`) — not `apps/api`. This is specifically so `apps/worker`'s recurring-invoice and dunning jobs call the *exact* code path `apps/api` uses on booking approval, instead of a second hand-rolled copy that could drift.
- **`apps/worker` is a plain Node/BullMQ process, not a second NestJS app.** It re-implements a small `notify()` helper (`apps/worker/src/notify.ts`) mirroring `apps/api`'s `NotificationsService` rather than sharing NestJS DI across two deployables — the worker has no HTTP surface and pulling in Nest would buy nothing.
- **Console v1 is one Next.js deployment per tenant** (`NEXT_PUBLIC_TENANT_SLUG` baked in at build time), not the PRD's eventual "single console URL with tenant switcher for platform admins" (§6) — that's explicitly Phase 4 platform-admin scope, premature for tenant #1.
- **The ledger is accrual-basis, not cash-basis** (`packages/database/src/ledger.ts`): AR is debited and Revenue/TaxPayable credited at invoice *issue*, not at payment. This is why the schema's `ACCOUNTS_RECEIVABLE` account exists at all — a cash-basis ledger would never need it. Deposits never touch Revenue or AR at any point (they're a liability from the moment cash lands, per PRD §7.2.4). `recordInvoiceIssuedEntries` lives in `packages/database/src/invoicing.ts`'s `persistInvoice`, so both `apps/api` (console-approved invoices) and `apps/worker` (recurring-cycle invoices) get identical ledger treatment automatically — one code path, not two.
- **Ledger writes are paired helper functions, not a generic "post a journal entry" API.** Every call site (`recordInvoiceIssuedEntries`, `recordPaymentReceivedEntries`, `recordDepositHeldEntries`, `recordDepositRefundedEntries`, `recordCreditNoteEntries`) writes both sides of its entry in one function — there is no way to call code that debits without also crediting. This is why the ledger balance-checked cleanly on the first try in live verification; a generic single-entry API would have made an unbalanced write a routine typo away.

## Known shortcuts (intentional, not bugs)

- `BookingService.handleInvoicePaid` hardcodes `contractRequired: false` — the triple-AND `APPROVED → ACTIVE` guard in `packages/domain` genuinely checks all three conditions, but contract e-sign enforcement has no real gate feeding it yet (no e-sign UI/upload exists). When contract upload ships, wire `contractRequired`/`contractSigned` from real `Contract` rows instead.
- `nextInvoiceNumber` (`packages/database/src/invoice-number.ts`) derives the sequence from a per-tenant monthly `COUNT(*)` inside the same transaction as invoice creation. Correct at demo scale; races under concurrent invoice creation for the same tenant. A dedicated Postgres sequence per tenant is the real fix (Phase 2).
- The dunning ladder (`apps/worker/src/jobs/dunning-ladder.job.ts`) hardcodes H-7/H-3/H-0/D+1/D+3/D+7/D+14 uniformly across tenants. `AutomationSetting` rows exist in schema for per-tenant override but the worker doesn't read them yet.
- Payment idempotency keys are generated server-side per `initiate()` call, not accepted from the client. True request-level idempotency (retry-safe from the storefront) is a TODO; webhook-level idempotency (the important one, preventing double-processing a gateway retry) IS implemented via the `WebhookEvent` unique `(provider, externalId)` constraint.
- Runtime Docker images copy the *full* installed `node_modules` (including devDependencies) from the build stage rather than doing a second prod-only `pnpm install`. Simpler and more robust for a pnpm workspace with symlinked local packages; costs image size. Revisit once there's a real build environment to validate a leaner runtime install against.
- Credit notes treat the entire credited amount as a Revenue reversal against AR (`recordCreditNoteEntries`), not split proportionally across Revenue/TaxPayable. Correct for crediting a whole remaining balance; approximate for a partial credit on a taxed invoice (the TaxPayable account will be very slightly overstated in that specific case). Exact proportional splitting is a small, contained fix if it ever matters — `FinanceService.createCreditNote` is the one call site.
- Deposit refunds always call `PaymentProvider.refund()` against the *original* payment's `providerRef` (best-effort lookup by booking + DEPOSIT line), never a manual-disbursement-only path. `MockPaymentProvider.refund()` doesn't validate the ref at all, so this was never exercised against a picky real gateway — when wiring real Xendit payouts, double check Xendit's refund API actually accepts a ref from an *invoice* payment for what's conceptually a *deposit* payout (PRD says deposit refunds go out via "Xendit payout," which is a different Xendit product/endpoint than a payment refund — this may need its own adapter method, not reuse of `refund()`).

## Open PRD questions still unanswered (§15)

None of these are answered yet — every decision they'd inform (deposit rule shape, notice period enforcement, PKP tax defaults) was implemented as a *configurable* value with a reasonable v1 default, specifically so answering these later doesn't require re-architecture:

1. Physical access control integration (smart locks) — not touched, no code assumes it.
2. Is tenant #1 PKP-registered? — seed data assumes `isPkp: true`; `computeTax()` in `packages/domain` already branches correctly either way, it's a per-tenant DB flag (`Tenant.isPkp`), not a code change.
3. Notice period / lien policy — `giveNotice()` currently enforces no minimum notice period at all. `AutomationSetting` schema can hold it; nothing reads it yet.
4. Deposit policy (fixed vs multiple of rent) — both are already implemented (`DepositRule` union type), tenant/AssetType picks per `AssetType.pricing.depositRule`.
5. Existing customer/lease migration — no import tooling exists; `prisma/seed.ts` is the closest template for a one-off data-loading script.
6. Contract signing (wet-sign vs Privy/e-Meterai) — schema supports either (`Contract.documentUrl`); no upload UI for either yet.
7. Who owns approval / SLA working hours — `reservedUntil` TTL is hardcoded to 48h in `BookingService`, not tenant-configurable yet.

---

## Local development

See root [`README.md`](../README.md) for the full run/deploy instructions.
Quick reference: `pnpm install`, spin up Postgres+Redis (locally or via
`docker compose up postgres redis`), `pnpm --filter @rentos/database migrate:deploy && pnpm --filter @rentos/database seed`,
then `pnpm dev` (turbo runs all 4 apps).

## Railway deployment — dashboard steps (no CLI login available this session)

Railway CLI login was attempted and is blocked in this sandbox
(`backboard.railway.com` returns 403 through the egress proxy — a policy
block, not a config issue). Nobody has clicked through actual Railway
provisioning yet. When you do:

1. Create a Railway project, connect this GitHub repo.
2. Add the **Postgres** and **Redis** plugins.
3. Add four services from the same repo, each with **Config File Path** set (Settings → Build) to `apps/api/railway.toml`, `apps/worker/railway.toml`, `apps/storefront/railway.toml`, `apps/console/railway.toml` respectively — the Dockerfile paths inside those files are already repo-root-relative, so leave each service's Root Directory as `/`.
4. Wire `DATABASE_URL` (api/worker) via Railway's Postgres reference variable; run the `rentos_app` role creation + `ALTER ROLE ... PASSWORD` from the `enable_rls` migration once, then set `DATABASE_URL_APP` to that role's connection string manually (Railway's Postgres plugin only gives you the owner URL by default).
5. Set `REDIS_URL` via Railway's Redis reference variable on api + worker.
6. Set the rest of the variables from [`.env.example`](../.env.example) per service (`JWT_SECRET`, `MESSAGING_PROVIDER`, `PAYMENT_PROVIDER`, and the storefront/console `NEXT_PUBLIC_*` **build** variables).
7. Run migrations once (`railway run --service api -- pnpm --filter @rentos/database migrate:deploy`, or a manual one-off) — there's no automatic migrate-on-deploy hook configured yet; docker-compose's `migrate` service is the local-dev equivalent, but Railway has no direct analog to "run once before other services start" without a pre-deploy command, which isn't configured here.
