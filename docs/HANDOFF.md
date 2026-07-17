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
| **1 — Storage MVP** | Storefront, approval workbench, RECURRING_LEASE engine, invoicing+webhooks, dunning, customer portal, P0 reports | ✅ Core loop done and verified end-to-end (see "What's proven" below), including the customer-facing pay-now flow (Session 3), KYC upload + review (Session 4), and the contract e-sign gate (Session 5). 🚧 Remaining gaps: request-info/customer-reply UI, unit reassignment on approve UI |
| **2 — Finance depth & automation** | Deposit payouts, refunds, credit notes, maker-checker, unit map, swap requests, e-sign, accounting export, month-end view | 🚧 In progress. ✅ Done: double-entry ledger (accrual basis, verified balanced live), manual payment recording with a real proof-of-payment upload (Session 6) + maker-checker verification (console UI), deposit refund request/approve workflow (console UI), credit note issuance with automatic replacement invoice for the remaining balance (Session 7, console UI), nightly ledger-balance-check worker job. ⬜ Still missing: unit map, swap requests, e-sign, accounting export, month-end view, partial deposit application against damages |
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

**Session 4 (KYC upload + review):** Added a `StorageProvider` port
(`apps/api/src/storage/`) following the same pattern as
`PaymentProvider`/`MessagingProvider` — `LocalDiskStorageProvider` default
(zero config), `S3StorageProvider` coded against the real AWS SDK
(S3-compatible: works with AWS S3, Cloudflare R2, MinIO via `S3_ENDPOINT`),
selected via `STORAGE_PROVIDER=local_disk|s3`. Built the KYC module
(`apps/api/src/kyc/`) as a proxied multipart upload (not a presigned-URL
direct-to-storage flow — simpler to get right at this scale; see
"Architectural decisions"). **Verified live end-to-end**: customer uploads
a KTP → staff reviews queue → previews the file (byte-for-byte roundtrip
confirmed with `diff` against the original) → verifies KTP alone →
customer's overall `kycStatus` correctly stays `PENDING_REVIEW` (selfie
still outstanding) → verifies selfie too → customer flips to `VERIFIED`
only once *every* submitted document is approved. Added
`GET /customers/me` (new endpoint) for the storefront profile page. Built
`apps/storefront/portal/kyc` (upload UI, per-document status) and
`apps/console/kyc` (review queue, in-app document preview via
blob-fetch-then-object-URL since a plain `<a href>` new-tab open can't
carry the Bearer token a protected file endpoint requires).

**Session 5 (contract e-sign gate):** Turned on the last hardcoded `false`
in the `APPROVED → ACTIVE` triple-AND guard. A `Contract` row is now
created automatically on booking approval; whether signing it is a hard
gate is a per-tenant `contract_required` feature flag (off by default —
`packages/database/prisma/seed.ts`). This required a real refactor, not
just flipping a flag: payment and contract signing are two independent
async gates that can complete in either order, and `handleInvoicePaid`
previously assumed contract was always satisfied. It now computes the
guard context for real and, when the guard fails because the contract
isn't signed, catches that specifically and leaves the booking `APPROVED`
— the invoice is still marked `PAID` by the caller, nothing throws, no
existing behavior broke. A new `tryActivateAfterContractSigned` mirrors
it from the other direction, called after a signature upload. **Verified
live, all three scenarios**, using a temporarily-enabled
`contract_required` flag on the seed tenant: (1) baseline — flag off,
booking activates on payment exactly as before, confirming the refactor
didn't regress the previously-verified path; (2) pay first, contract
unsigned — invoice correctly reached `PAID` while the booking stayed
`APPROVED` (no exception); signing the contract afterward correctly
activated it, moved the asset to `OCCUPIED`, and — notably — created the
deposit at that point rather than at payment time, since deposit
creation lives in the shared `finalizeActivation` tail; (3) sign first,
pay second — booking stayed `APPROVED` after signing alone, then
activated on payment. Ledger stayed balanced across all three bookings
created during this test. Built `apps/api/src/agreements/` (named to
avoid confusion with the unrelated `packages/contracts` DTO package),
reusing the KYC session's `StorageProvider`/multer upload pattern
directly. Either the customer (self-serve) or ops/finance staff
(recording a paper contract collected in person) can upload — added
`apps/storefront/portal/bookings/[id]`'s contract section and a new
`apps/console/bookings/[id]` staff detail page (console had none before
this).

33 unit tests in `packages/domain` cover the state machines and
proration/tax math. All 4 apps + 3 packages typecheck, build, and pass
`turbo run typecheck test build` clean (verified with `--force` after the
turbo.json fix, to rule out stale-cache false positives).

**Session 6 (proof-of-payment upload):** `PaymentsService.recordManual`
now takes a real file (multipart, same `FileInterceptor` + `StorageProvider`
pattern as KYC/contracts) instead of a free-text `proofUrl`; the stored
`proofUrl` column now holds a storage key, not a URL. Added a staff-only
`GET /payments/:id/file` (roles `SUPER_ADMIN`/`OPS_ADMIN`/`FINANCE_ADMIN`,
same buffer-or-redirect shape as the KYC/contract file reads). Verified
live: a `text/plain` upload correctly 400s (`ALLOWED_CONTENT_TYPES` gate);
a real PNG upload succeeds and round-trips byte-for-byte through
`GET /payments/:id/file` (`cmp` confirmed identical bytes on disk under
`UPLOAD_DIR/payments/<tenantId>/<invoiceId>/<uuid>`); the maker-checker
rule is unaffected by the refactor — re-confirmed a recorder gets 403 on
their own `verify()` call (both via role-gating for an `OPS_ADMIN` and via
the same-person check for a `SUPER_ADMIN` who can hold both roles), and a
different `FINANCE_ADMIN` verifying correctly flips the invoice to `PAID`.
Ledger balance re-checked clean after all of it. Console's invoice detail
page swapped its proof text input for a real file input + a "View proof"
button (blob preview via `apiFetchBlob`, same pattern as the KYC review
queue).

**Session 7 (automatic credit-note replacement invoice):** `ADJUST`ing an
invoice via credit note now actually implements PRD §8.2's "superseded by
CREDIT_NOTE + new invoice", not just the CREDITED half of it.
`computeCreditReplacementDraft` (`packages/domain/src/pricing/credit-note.ts`,
5 new unit tests) is a pure function: given the original invoice's lines
and total plus the credit amount, it scales every line down by the same
ratio — preserving each line's `lineType`, since the ledger's revenue
recognition depends on knowing which lines are DEPOSIT/TAX vs. revenue —
and reconciles rounding by dropping any remainder on the last line so the
scaled lines always sum to exactly `totalAmount - creditAmount`, never a
cent off. `createCreditReplacementInvoice`
(`packages/database/src/invoicing.ts`) persists that draft through the
same code path `persistInvoice` already used (refactored into a shared
`persistInvoiceCore` so both share one Prisma-write + ledger-recording
implementation instead of two). `FinanceService.createCreditNote` calls it
only when the credit is **partial** — a full-amount credit note leaves
`supersededByInvoiceId` null, since there's no remaining balance to bill.
Verified live: a IDR 100,000 partial credit against a real
747,193.55 invoice produced a correctly-linked replacement invoice
totalling 647,193.55 with all four original lines (admin fee, deposit,
rent, PPN) scaled proportionally and summing exactly to the new total;
issuing a second, full-amount credit note against *that* replacement left
`supersededByInvoiceId` null and created no further invoice (confirmed via
invoice count staying flat); over-amount credit notes still correctly
400. Ledger balance re-checked clean after both credit notes. Added
`InvoiceDto.supersededByInvoiceId` to `packages/contracts`, and both the
console and storefront invoice detail pages now show a banner linking to
the replacement invoice when one exists (or a "credited in full" note
when it doesn't).

### What's explicitly NOT done (don't assume it exists)

- Real e-signature providers (Privy/e-Meterai) — PRD explicitly scopes wet-sign PDF upload as v1-acceptable (§11); that's what's built. `ESignProvider` as its own port/adapter (matching Payment/Messaging/Storage) is Phase 2 if a tenant needs legally-binding e-Meterai stamping.
- Per-tenant `AutomationSetting` rows are schema-only — `apps/worker`'s dunning ladder hardcodes the H-7/H-3/H-0/D+1/D+3/D+7/D+14 steps uniformly, doesn't read tenant config
- Partial deposit application against damages (`Deposit.appliedAmount` / `PARTIALLY_APPLIED` / `APPLIED` states exist in schema, unused — v1 refund workflow only handles the full-amount HELD → REFUND_REQUESTED → REFUNDED path)
- Invoice-payment refunds (as opposed to deposit refunds) — no endpoint; `PaymentProvider.refund()` is only called from the deposit-refund flow today
- Automated KYC verification (Verihubs or similar) — PRD explicitly scopes this to P2; v1 review is 100% manual, by design.
- Unit map (visual grid) — list view only (P1 in PRD anyway)
- Swap/upgrade requests, promo codes, duration discounts — schema exists, zero application logic
- Platform admin console (multi-tenant switcher, tenant provisioning wizard) — out of scope until Phase 4; today, provisioning a tenant means writing rows directly (see `packages/database/prisma/seed.ts` as the template)
- Real Xendit/WhatsApp Cloud credentials — adapters are coded against the real APIs but unconfigured; `PAYMENT_PROVIDER=mock` / `MESSAGING_PROVIDER=console_log` is what actually runs today
- **Docker builds were never actually executed in this sandbox** — Docker Hub registry access is blocked by this environment's egress policy (confirmed via repeated 403s on `production.cloudfront.docker.com`, same class of block as `backboard.railway.com`). The Dockerfiles follow standard, well-established patterns (Turborepo `prune --docker`, Next.js `output: standalone`) and `turbo prune` itself was verified working locally, but nobody has run `docker build` or `docker compose up` against them. **Validate this first** in any environment with real registry access before trusting it blindly.

---

## Resume here

Refunds/credit-notes/maker-checker/ledger (Session 2) with their console +
storefront UI (Session 3), the storefront pay-now flow (Session 3), KYC
upload + review with real object storage (Session 4), the contract
e-signature gate wired into the `APPROVED → ACTIVE` triple-AND guard
(Session 5, `apps/api/src/agreements`), proof-of-payment as a real
`StorageProvider` upload instead of a text field (Session 6), and the
automatic credit-note replacement invoice (Session 7) are all done —
every major PRD §7.1/§7.2 P0 flow now has both a working API and
reachable UI, the booking activation guard is no longer stubbed on any of
its three conditions, every document-bearing flow (KYC, contracts, manual
payments) uses the same upload/preview pattern, and invoice corrections
now match the PRD's documented lifecycle exactly (§8.2) instead of
stopping halfway. Next highest-leverage chunks, in rough priority order:

1. Work down PRD §13 Phase 2's remaining items: unit map, swap requests,
   accounting export, month-end view.
2. Real e-signature provider (Privy/e-Meterai) as an `ESignProvider` port
   if a tenant needs legally-binding stamping beyond wet-sign PDF (v1
   scope per PRD §11 — see "Architectural decisions log").
3. Partial deposit application against damages (schema exists, unused —
   see "What's explicitly NOT done").

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
- **KYC upload is a proxied multipart POST, not a presigned-URL direct-to-storage flow** — deliberately simpler than the two-step "presign, then PUT to storage, then tell the API the key" dance many production systems use. The original `packages/contracts/src/customer.ts` comment described the presigned-URL approach before this session actually built the upload; that comment was wrong and has been corrected. Bytes transit our own API over TLS once, server-side, and `StorageProvider.save()` handles the rest — correct and simple at this scale. Revisit only if upload volume/size ever makes proxying through the API a real bottleneck.
- **A customer is `VERIFIED` only when every KYC document they've submitted is `VERIFIED`** (`KycService.review`), not just the most recently reviewed one — checked by re-querying all of that customer's `KycDocument` rows after each review and requiring both a KTP and a SELFIE to exist and all be `VERIFIED`. A fresh upload always reopens `PENDING_REVIEW` even if other documents were already verified. Verified live: verifying KTP alone left the customer `PENDING_REVIEW`; verifying the selfie too flipped them to `VERIFIED`.
- **`LocalDiskStorageProvider` is dev/demo-only, not Railway-production-safe as configured** — container filesystems are ephemeral across deploys/restarts unless a persistent Volume is explicitly mounted at `UPLOAD_DIR`. Real KTP/selfie images (actual PII, PRD §10 "encrypted PII at rest") must go through `S3StorageProvider` (`STORAGE_PROVIDER=s3`) before this touches production, or a Volume needs to be attached to the api service on Railway. This is flagged loudly in the provider's own doc comment specifically so it isn't missed.

## Known shortcuts (intentional, not bugs)

- Contract sign-off and invoice payment are two independent async gates that can complete in either order (`BookingService.computeActivationContext`/`finalizeActivation`, `apps/api/src/booking/booking.service.ts`). `handleInvoicePaid` catches `GuardFailedError` and returns quietly when payment lands before the contract is signed (booking stays `APPROVED`); `AgreementsService.sign()` calls `tryActivateAfterContractSigned` after a signature lands, which is a no-op if the invoice isn't paid yet. Whichever gate closes second is the one that actually fires the `ACTIVATE` transition. Verified live for all three cases: `contract_required` flag off, pay-then-sign, and sign-then-pay.
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
