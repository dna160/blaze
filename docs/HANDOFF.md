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
| **2 — Finance depth & automation** | Deposit payouts, refunds, credit notes, maker-checker, unit map, swap requests, e-sign, accounting export, month-end view | ✅ **Complete** — every named item on PRD §13's list plus every gap found along the way is done: double-entry ledger (accrual basis, verified balanced live), manual payment recording with a real proof-of-payment upload (Session 6) + maker-checker verification (console UI), deposit refund request/approve workflow with partial-application support (Session 12, console UI), credit note issuance with automatic replacement invoice for the remaining balance (Session 7, console UI), nightly ledger-balance-check worker job, month-end close view + invoice/payment/ledger CSV export (Session 8, console UI, finance-roles-only), visual unit map + occupancy view (Session 9, console UI, staff-only), swap/upgrade requests with computed mid-cycle proration (Sessions 10 + 13, storefront + console UI), and a real ESignProvider port (Session 11, Privy adapter coded-but-unconfigured, MockESignProvider is the zero-regression default). Phase 3 is next. |
| **3 — Multi-vertical proof** | NIGHTLY + DURATION_ORDER real logic, pooled inventory, seasonal pricing, second tenant | ✅ **Every named item on PRD §13's Phase 3 list is done**, and the extensibility thesis has now been proven twice over. NIGHTLY (Session 14) and DURATION_ORDER (Session 15) are both real end-to-end. Two additional tenants are live with zero application code changes: `griya-nginap`/NIGHTLY (Session 16 — also found and fixed a real cross-tenant data leak) and `sewa-alat`/DURATION_ORDER (Session 19 — re-verified the Session 16 security fix holds at 3 tenants, not just 2). Pooled inventory (Session 17) drives genuine date-range-overlap capacity checking. Seasonal/dynamic pricing (Session 18) gives real per-night rate overrides. `HOURLY_SLOT` (venue/studio) is the one booking model still a stub, but it was never on Phase 3's named list — it's explicitly Phase-3-and-beyond, lowest priority, PRD's own "furthest out on the roadmap." |
| **4 — SaaS-ready** | Self-serve tenant signup, tenant billing, visual automation builder, OTA sync, KYC automation | ✅ **Complete** — every named item on PRD §13's Phase 4 list is done and live-verified: tenant-facing read API + outbound webhooks (Session 20, `gudang-aman`), automated KYC verification (Session 21, `sewa-alat`), OTA calendar sync via iCal (Session 22, `griya-nginap`), and — closing out the three items previously flagged as business-shaped decisions — self-serve tenant signup, tenant billing/metering, and a (deliberately scoped-down) visual automation builder for the dunning ladder, all Session 26, gated to one demo `PLATFORM_ADMIN` account plus `gudang-aman` for the automation builder specifically. User explicitly authorized proceeding on the three business-shaped items ("authorized, self serve, billing and automation builder, implement it only in one user as a form of demo") — see Session 26's entry for the concrete decisions made under that authorization. |

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

**Session 8 (month-end close + accounting export):** PRD §7.2.4's
"month-end close view: revenue recognized, deposits held, AR, refunds"
and "exports: invoice/payment/ledger CSV" — the two features Phase 2's
success criteria ("finance closes a month in < 1 day") actually depend
on. `ReportingService.monthEndClose` (`apps/api/src/reporting/reporting.service.ts`)
computes revenue-recognized and refunds as *period flows* (net ledger
movement strictly within the selected month) but deposits-held,
AR, and tax-payable as *balance-sheet snapshots* (net movement from all
time up to the end of that month) — deliberately not the same shape,
since a liability/asset balance and an income-statement flow aren't
interchangeable even though both come out of the same `ledgerEntry`
table. Netting respects each account's normal side (REVENUE/liabilities
grow on CREDIT, AR grows on DEBIT) via a small `netBalance` helper, all
in `Decimal` (`@rentos/domain`'s `money`/`roundMoney`), never raw
`Number` math. Three CSV export endpoints
(`GET /reports/export/{invoices,payments,ledger}.csv`, `apps/api/src/reporting/csv.util.ts`
— a ~10-line RFC 4180 writer, no new dependency) accept optional
`from`/`to` query params and stream `Content-Disposition: attachment`.
Both month-end and the exports are gated to `SUPER_ADMIN`/`FINANCE_ADMIN`/`VIEWER`
only (method-level `@Roles` overriding the controller's broader
class-level default) — matching PRD Appendix C's "Reports: limited for
Ops Admin" by excluding Ops Admin from the financial-detail endpoints
specifically, while occupancy/AR-aging/booking-funnel stay open to all
four staff roles as before. Verified live: month-end defaults to the
current month when no `year`/`month` given; an explicit `year=2026&month=7`
returned `accountsReceivable: "80693.55"`, independently cross-checked
by hand-summing that tenant's `ACCOUNTS_RECEIVABLE` ledger rows
(1,916,540.33 debits − 1,835,846.78 credits = 80,693.55, exact match) —
notably this is *higher* than `/reports/ar-aging`'s total (which read 0,
since it only counts invoices currently `ISSUED`/`OVERDUE`), because a
Session-2-era partial credit note against a since-CREDITED invoice left
orphaned AR that the ledger correctly still carries — a real illustration
of why a ledger-truth month-end view is worth having independently of
the invoice-status view. Confirmed all 3 CSVs download with correct
headers/content, `from`/`to` filtering excludes out-of-range rows, invalid
dates 400, and `OPS_ADMIN` gets 403 on both `/reports/month-end` and every
`/reports/export/*` route while still reaching the three P0 reports.
Console's `/reports` page gained a month picker, five stat tiles, and
three "Export ... .csv" buttons (visible only to
`SUPER_ADMIN`/`FINANCE_ADMIN`/`VIEWER`), downloading via a new
`apiDownload` helper (`apps/console/src/lib/api.ts`) that fetches the
blob — to carry the Bearer token, same reasoning as `apiFetchBlob` — and
triggers a real save-as via a temporary anchor's `download` attribute.

**Session 9 (visual unit map + occupancy view):** PRD §7.2.2's "visual
unit map (grid/floor layout) with status colors" (P1) and "occupancy
view: who's in which unit, since when, paid-through date" (P0), combined
into one staff-only view instead of two. Deliberately did **not** add a
new `GET /catalog/assets` response shape for this — that endpoint is
unauthenticated by design (the public storefront catalog, PRD §7.1.1
"prices visible without login"), and the occupancy view needs customer
name/phone, which is PII that must never ride an unauthenticated route.
Added a separate `GET /catalog/assets/unit-map`
(`apps/api/src/catalog/catalog.controller.ts`) gated with
`JwtAuthGuard`+`RolesGuard` (`SUPER_ADMIN`/`OPS_ADMIN`/`FINANCE_ADMIN`/`VIEWER`)
at the method level, on the *same controller* as the public list — the
existing `listAssets` endpoint and its response shape are untouched.
`CatalogService.unitMap` joins each asset to its current ACTIVE/RENEWING/
SUSPENDED booking (at most one, per the booking FSM) and that booking's
most recently `PAID` invoice, giving occupant name, move-in date, and
paid-through date in one query — no new schema needed. The grid itself
groups by location, then by each unit code's leading letters ("A-01" →
row "A") — a pragmatic reading of "grid/floor layout" that needs zero new
x/y-coordinate fields, since v1's seeded codes (and presumably real
storage facilities) already encode row/section in the code prefix.
Console's `/assets` page now has a Unit map / List toggle over the same
staff-only data; clicking a tile opens a detail panel with occupant,
move-in date, and paid-through date for occupied units.

Verified live: the public `/catalog/assets` endpoint still returns zero
PII with no `Authorization` header (confirmed by inspecting the raw
response); `/catalog/assets/unit-map` correctly 401s with no token;
logged-in `OPS_ADMIN` sees occupant/paid-through data for occupied
units and `null` for non-occupied ones; `locationId` filtering works.
One incidental finding, not a bug in this session's code: asset `A-01`
is `OCCUPIED` in the seed/test data but has no active booking — leftover
drift from earlier sessions' live-testing that the new view correctly
surfaces as "No active tenant" rather than crashing or fabricating data;
worth a manual `asset.status` correction if it's ever noticed live,
not a code fix.

**Session 10 (swap/upgrade requests):** PRD §7.1.4's "request
upgrade/downsize... creates a swap request routed to admin" and the
persona table's "Grow/Shrink: swap request in portal → prorated switch."
New `SwapRequest` model (`packages/database/prisma/migrations/20260717142334_add_swap_requests`,
RLS-covered — new tables aren't retroactively covered by the original
`enable_rls` migration, so this one repeats the ENABLE/FORCE/POLICY
statements itself, same shape). Customer picks a target `AssetType` +
reason on an `ACTIVE`/`RENEWING` booking (`POST /swap-requests`); staff
approve by picking the actual replacement unit from what's currently
`AVAILABLE` of that type (`POST /swap-requests/:id/approve`), which
reassigns both units through `assetFsm` (old `OCCUPIED→AVAILABLE`, new
`AVAILABLE→RESERVED→OCCUPIED`, mirroring how booking activation moves an
asset) and re-snapshots the booking's `assetId`/`assetTypeId`/`priceSnapshot`
to the new type. `Booking.priceSnapshot`'s doc comment says pricing is
"frozen at submission time — never re-derived from AssetType later"; a
swap is the one deliberate, documented exception, since the customer is
now genuinely on a different unit/rate. **Intentional v1 scope limit**:
approval does *not* auto-generate a mid-cycle proration invoice/credit
for the switch-over day — the existing invoice model has no clean way to
represent a signed adjustment (see "Known shortcuts"). Staff can issue a
manual credit note or manual charge for the partial period using the
tools already built if the tenant's policy requires exact proration.
Console gets a new "Swap Requests" nav item/queue page (approve flow
fetches available units of the requested type inline, reject prompts for
a reason); storefront booking detail page gets a request form (visible
on `ACTIVE`/`RENEWING` bookings, hidden while a request is already
pending) and shows swap request history/status.

Verified live: customer submits a swap request → staff queue shows full
context (current unit/type, requested type, reason) → wrong-asset-type
approval attempt 400s → correct approval reassigns both units (old unit
back to `AVAILABLE`, new unit `OCCUPIED`), updates the booking's
asset/type/priceSnapshot to the new (cheaper) type, and writes a
`BookingEvent`; re-approving an already-`APPROVED` request 409s; a
second request rejected with a reason correctly leaves that booking
untouched; a customer can't submit for someone else's booking (403) or
double-submit while one's pending (409); a customer can view their own
booking's swap history but not another customer's (403). Ledger balance
unaffected throughout (swap has no ledger entries in v1, by design).

**Session 11 (real e-sign provider — closes out PRD §13 Phase 2's list):**
`ESignProvider` (`apps/api/src/agreements/esign-provider.interface.ts`),
matching the Payment/Messaging/Storage port pattern exactly.
`AgreementsService.sign()` now routes every upload through
`esign.sendForSignature()` instead of always immediately marking the
contract signed — `MockESignProvider` (default) signs synchronously,
so **this is a zero-behavior-change refactor for the existing wet-sign
flow**; `PrivyESignProvider` is coded against Privy's (privy.id)
documented digital-signature/e-Meterai REST API shape but returns
`PENDING` and requires `PRIVY_API_KEY`/`PRIVY_MERCHANT_KEY` to actually
run — like `XenditPaymentProvider`, this has not been exercised against
a live Privy sandbox, only structurally verified; validate against
current Privy docs before pointing it at production. Selecting it is a
single env var (`ESIGN_PROVIDER=privy`, `agreements.module.ts`) — no
call-site change. Added `Contract.esignProvider`/`esignEnvelopeId`/
`esignStatus` columns (simple `ALTER TABLE`, `contracts` already had RLS
from the original migration, nothing new to enable). New
`POST /contracts/webhook/:tenantSlug` mirrors the payment webhook's
shape exactly (tenant resolved from the path, not Host/JWT, since a
gateway callback never carries the tenant's subdomain) and is unreachable
under Mock, which never sends a webhook. This also required moving
`AgreementsController`'s auth from a class-level `@UseGuards(JwtAuthGuard)`
to per-method guards (matching `PaymentsController`'s existing shape),
since a webhook route can't carry a JWT and class-level guards can't be
selectively unset per-method in Nest.

Verified live: booking → approve → sign → pay flow under
`ESIGN_PROVIDER=mock` (the default, unset in `.env.example`) produces
byte-identical results to the pre-refactor behavior — contract signs
synchronously, booking reaches `ACTIVE` — confirming zero regression on
the path every prior session's contract-gate testing depended on.
Switching to `ESIGN_PROVIDER=privy` with no credentials set correctly
throws a clear, actionable error (visible in server logs, generic 500 to
the client) at the exact point Xendit's adapter does the same thing —
same failure shape, same convention. The webhook endpoint 404s cleanly
for an unknown tenant slug and surfaces a clear error for a missing
signature header. Storefront/console contract sections now show "Sent
for e-signature via {provider} — waiting for the signature to complete"
distinct from the plain "Not signed yet" state, and hide the re-upload
form while a real-provider signature is pending. This closes the last
named item on PRD §13 Phase 2's explicit list.

**Session 12 (partial deposit application against damages):** PRD
§7.2.4's "applied against damages/final invoice" — the one gap the
schema had been carrying since early sessions (`Deposit.appliedAmount`,
`PARTIALLY_APPLIED`/`APPLIED` statuses) with no workflow behind it.
`DepositsService.applyToDamages` (`SUPER_ADMIN`/`FINANCE_ADMIN` only —
same RBAC bar as issuing a credit note, since it's a unilateral
deduction from customer funds) lets staff deduct part or all of a
`HELD`/`PARTIALLY_APPLIED` deposit with a reason, repeatable up to the
deposit's full amount. `recordDepositAppliedEntries`
(`packages/database/src/ledger.ts`) debits `DEPOSIT_LIABILITY` and
credits `REVENUE` — applying a deposit converts liability into revenue
at the moment of the decision, no cash moves. Every application is also
written to the existing (previously under-used) `AuditLog` via
`AuditService` — a deduction from customer funds is exactly the kind of
action PRD §7.2.7's "immutable audit log... protects the owner from his
own staff" exists for. `requestRefund`/`approveRefund` were changed to operate on
`amount - appliedAmount` (the remaining balance) instead of the full
deposit amount — harmless before this session since `appliedAmount` was
always 0 with no application workflow to move it, but necessary now
that `applyToDamages` exists: refunding the full `amount` after a
partial application would double-pay the applied portion. `requestRefund`
also now allows `PARTIALLY_APPLIED` (not just `HELD`)
and blocks requesting when nothing remains. Console's deposits page
gained a Remaining column, an "Apply to damages" inline form, and the
approve-refund button now shows the actual amount it will pay out.

Verified live: applying 50,000 then 400,000 against a 450,000 deposit
correctly transitions `HELD` → `PARTIALLY_APPLIED` → `APPLIED`;
over-amount and already-`APPLIED` applications 400/409 as expected; an
`APPLIED` deposit correctly can't be refunded (409, "nothing left to
refund"); a separate deposit partially applied (100,000) then
refunded showed a `payoutRef` proving the remaining 350,000 — not the
full 450,000 — was what actually got paid out; `OPS_ADMIN` correctly
403s on `/deposits/:id/apply`. Ledger balance stayed at exactly 0.00
throughout, and every application produced a matching `AuditLog` row
with the amount and reason.

**Session 13 (swap-request mid-cycle proration — the last known Phase 2
gap):** `computeSwapProration` (`packages/domain/src/pricing/swap-proration.ts`,
5 new unit tests) is a pure function: given the old/new monthly rates and
the current billing period's bounds, it returns `daysRemaining`,
`oldRateUnusedCredit`, `newRateCharge`, and `netAdjustment` (positive =
customer owes more, negative = they're owed a credit). Both period
bounds are **inclusive** (matching `periodEndFor`'s existing convention
of "last day of the period," not an exclusive boundary) — this required
a `+1` on both the total-days and remaining-days calculations that's
easy to get wrong; the unit tests pin a full-31-day period counting as
31, not 30. `SwapRequestsService.approve()` now looks up the booking's
most recently `PAID` invoice (the actual billed period, not a date
re-derived from `anchorDay` math that could drift after a credited/
replacement invoice) and calls `computeSwapProration` with today as the
switch date, storing the result on two new `SwapRequest` columns
(`prorationNetAdjustment`, `prorationDaysRemaining`; null when no `PAID`
invoice exists yet to derive a period from). **Deliberately stops
there** — it does not auto-generate an invoice or credit note for the
computed number. A downsize produces a negative `netAdjustment`, and
this codebase's invoice model has no negative-amount convention:
nothing downstream (payments, dunning, the storefront UI) is built to
represent one, and inventing that under this scope would be building on
an unproven assumption rather than reusing what's already proven.
Instead, the number is surfaced directly to staff — console's swap
queue shows a banner after approval ("customer owes an additional Rp X"
/ "customer is owed a credit of Rp X" / "no manual adjustment needed" /
"proration wasn't computed") with the exact days-remaining and amount,
and staff act on it with the tools already built: a manual credit note
for a downsize, a manual charge for an upgrade.

Verified live against three real scenarios on actual `PAID` invoices:
an upgrade (450,000 → 1,200,000/mo, 30 of 31 days remaining) computed a
net adjustment of exactly 725,806.45 — hand-verified as
`(1,200,000/31 − 450,000/31) × 30`; the symmetric downsize produced
exactly `-725,806.45`; a booking with no `PAID` invoice yet correctly
returned `null` for both fields rather than a wrong or crashing
computation. Ledger balance stayed at 0.00 throughout (proration is
compute-only — no ledger entries by design). This closes the last known
Phase 2 gap; every named item on PRD §13 Phase 2's list plus every
gap this session series found along the way is now done.

**Session 14 (NIGHTLY real booking-model logic — first Phase 3 vertical):**
`NightlyStrategy.computeInitialInvoice` (`packages/domain/src/booking-model/nightly.strategy.ts`,
7 new unit tests) replaced the typed stub with real math: nights ×
`pricing.basePrice` (the field is reused for a per-night rate on a
NIGHTLY `AssetType`, same JSON shape as RECURRING_LEASE's per-month
rate — only the unit changes), plus the same admin-fee/deposit/PPN line
assembly RECURRING_LEASE uses. That line-assembly logic was pulled out
of `recurring-lease.strategy.ts` into a shared
`booking-model/invoice-builder.ts` (`buildInvoiceDraft`) so both
strategies share one tax/deposit implementation instead of a second
hand-copied one. `computeFinalSettlement` stays a documented
`BookingModelNotImplementedError` stub — NIGHTLY's FSM has no
early-checkout/`GIVE_NOTICE` transition yet (PRD Appendix B's `EXTENDED`
state), so it's genuinely unreachable from the golden path, not an
oversight.

`Booking.endDate` already existed in the schema and `BookingDto` from an
earlier session but was never read or written anywhere — this session
actually wired it: `CreateBookingRequestSchema` gained an optional
`endDate`, `BookingService.createBooking` requires and validates it
(`endDate > startDate`) specifically when the target `AssetType.bookingModel`
is `NIGHTLY`, and `BookingForInvoicing`/`generateInitialInvoice`
(`packages/database/src/invoicing.ts`) thread it into the
`BookingWindow` the strategy sees. No migration was needed.

The bigger architectural piece: `BookingService.handleInvoicePaid`
previously assumed every first payment fires `ACTIVATE` (the
RECURRING_LEASE triple-AND-gated transition). It's now booking-model-aware
— NIGHTLY/DURATION_ORDER fire `PAYMENT_RECEIVED` instead (`APPROVED → PAID`,
per `nightlyBookingFsm`/`durationOrderBookingFsm`, which already existed
in `packages/domain/src/state-machine/booking-fsm.ts` from an earlier
session but had never actually been reached by any code path). This is
also where a NIGHTLY deposit gets created (`recordDepositIfNeeded`,
extracted as a shared private helper used by both this path and the
existing `finalizeActivation`) — the "money landed" moment for NIGHTLY
is first payment, not activation, since there's no triple-AND gate to
wait on. Two new service methods, `checkIn`/`checkOut`
(`apps/api/src/booking/booking.service.ts`), plus
`POST /bookings/:id/check-in` and `/check-out`
(`SUPER_ADMIN`/`OPS_ADMIN`), drive `PAID → CHECKED_IN` (moves the asset
`RESERVED → OCCUPIED`) and `CHECKED_IN → CHECKED_OUT → CLOSED` in one
call (moves the asset back to `AVAILABLE`) — NIGHTLY's stay is paid in
full upfront, so there's no final-settlement invoice to wait on between
those two transitions. **Both methods explicitly gate on
`booking.bookingModel === "NIGHTLY"`** (400 otherwise) rather than
letting DURATION_ORDER fall through into FSM transitions it doesn't
support — DURATION_ORDER's pickup/return verbs are out of scope for this
session, tracked below, not silently half-wired.

Storefront: `BookingForm` now takes a `bookingModel` prop and renders a
second (checkout) date input only for NIGHTLY, client-side validates
`endDate > startDate` before submitting; the asset-type detail page
shows "/night" instead of "/month" and phrases the deposit multiple
against "nightly rate" instead of "monthly rent" when applicable.
Console's booking detail page gained a "Stay" card (NIGHTLY + `PAID`/`CHECKED_IN`
only) with Check in / Check out buttons.

Verified live end-to-end against a temporary NIGHTLY `AssetType` +
`Asset` seeded directly via `psql` (same pattern as every prior
session's live-testing, cleaned up after): submit a 3-night booking
(Aug 1 → Aug 4) → `PENDING_APPROVAL` → approve → invoice `RENT` line
read exactly "Room rate (3 nights × 500000)" totalling 1,500,000, full
invoice total 2,192,750 (1,500,000 rent + 25,000 admin fee + 167,750 PPN
+ 500,000 deposit) — hand-verified against the exact same formula the
unit tests pin. Mock payment via `POST /payments/initiate` (customer
JWT, OTP read from Redis per the established pattern) flipped the
booking straight to `PAID` (not `ACTIVE`) with a `HELD` deposit of
500,000 created and the asset still `RESERVED` — confirming
RECURRING_LEASE's activation path was untouched by the refactor.
Check-in moved the booking to `CHECKED_IN` and the asset to `OCCUPIED`;
check-out moved it to `CLOSED` and the asset back to `AVAILABLE`.
Edge cases: booking a NIGHTLY `AssetType` with no `endDate` 400s
("A checkout date is required"); `endDate` before `startDate` 400s;
check-out on an already-`CLOSED` booking 409s (`ILLEGAL_TRANSITION`);
check-in on a `CLOSED` booking 409s; check-in on a still-`APPROVED`
(unpaid) NIGHTLY booking 409s (no `ACTIVATE` transition from `APPROVED`
in `nightlyBookingFsm` — only from `PAID`); check-in on a
RECURRING_LEASE booking 400s with the explicit "not implemented for
RECURRING_LEASE" message rather than a confusing FSM error. Ledger
balance independently summed to exactly 0.00 after the full flow
(invoice-issue + payment + deposit-hold entries all landed correctly);
re-confirmed 0.00 again after test-data cleanup. `packages/domain`'s
`registry.test.ts` was updated to reflect that NIGHTLY's
`computeInitialInvoice` is no longer a stub (only `computeFinalSettlement`
still is) — the old test asserted the whole strategy threw, which this
session's change correctly broke. Full `turbo run typecheck test build --force`
passes clean across all 8 packages (50 domain unit tests, up from 42).

**Session 15 (DURATION_ORDER real booking-model logic — second Phase 3
vertical):** Followed Session 14's NIGHTLY as the direct template.
`DurationOrderStrategy.computeInitialInvoice`
(`packages/domain/src/booking-model/duration-order.strategy.ts`, 7 new
unit tests) is days × `pricing.basePrice` (reused as a per-day rate,
same pattern as NIGHTLY's per-night reuse) plus the same shared
`buildInvoiceDraft` admin-fee/deposit/PPN assembly — no third copy of
that logic, it's the same one Session 14 already extracted.
`computeFinalSettlement` stays a stub for the same reason NIGHTLY's
does: no early-return path exists on `durationOrderBookingFsm` yet.
`endDate` validation in `BookingService.createBooking` now covers both
NIGHTLY and DURATION_ORDER via one `BOOKING_MODELS_REQUIRING_END_DATE`
set instead of a single hardcoded check — no schema or contract changes
needed, since `endDate` was already threaded generically through
`BookingWindow`/`BookingForInvoicing` in Session 14.

The real new piece: DURATION_ORDER's FSM (`durationOrderBookingFsm`,
pre-existing but unreached until now) has one more state than NIGHTLY —
`PICKED_UP → RETURNED → INSPECTION → CLOSED` instead of a direct
`CHECKED_IN → CHECKED_OUT → CLOSED` — modeling the equipment-rental
reality that a returned item needs a damage check before it can be
re-listed. Three new `BookingService` methods, deliberately *not*
reusing `checkIn`/`checkOut`'s two-method shape: `pickUp` (`PAID →
PICKED_UP`, asset `RESERVED → OCCUPIED`), `returnEquipment`
(`PICKED_UP → RETURNED → INSPECTION` in one call — same "nothing real
to wait on between these two states" reasoning Session 14 used for
`checkOut`'s two-step collapse — asset `OCCUPIED → AVAILABLE →
MAINTENANCE`, deliberately routed through `MAINTENANCE` rather than
straight back to `AVAILABLE` so the unit can't be re-booked while
inspection is pending), and `completeInspection` (`INSPECTION →
CLOSED`, asset `MAINTENANCE → AVAILABLE` via `RETURN_TO_SERVICE`) — the
real decision point where staff would call the existing
`DepositsService.applyToDamages` (Session 12) before or after closing,
not automated here. New endpoints: `POST /bookings/:id/{pickup,return,
complete-inspection}` (`SUPER_ADMIN`/`OPS_ADMIN`). All three explicitly
gate on `booking.bookingModel === "DURATION_ORDER"` (400 otherwise),
mirroring `checkIn`/`checkOut`'s NIGHTLY-only gate — cross-model calls
fail with a clear message, not a confusing FSM error or silent
half-wiring.

Storefront's `BookingForm` generalized its NIGHTLY-only `endDate`
branch to a `needsEndDate` flag covering both models (pickup/return
date labels for DURATION_ORDER vs check-in/checkout for NIGHTLY); the
asset-type detail page shows "/day" pricing and "daily rate" deposit
phrasing for DURATION_ORDER. Console's booking detail page gained an
"Order" card (DURATION_ORDER + `PAID`/`PICKED_UP`/`RETURNED`/`INSPECTION`)
with Mark picked up / Mark returned / Complete inspection buttons,
alongside (not replacing) the existing NIGHTLY "Stay" card.

Verified live end-to-end against a temporary DURATION_ORDER
`AssetType` + `Asset` (equipment rental, seeded via `psql`, same
pattern as every prior session, cleaned up after): a 5-day order (Aug
10 → Aug 15) → approve → invoice `RENT` line read exactly "Rental fee
(5 days × 150000)" totalling 750,000, full invoice total 1,854,700
(750,000 rent + 20,000 admin fee + 84,700 PPN + 1,000,000 deposit) —
hand-verified against the same formula the unit tests pin. Mock
payment flipped the booking to `PAID` with a `HELD` deposit of
1,000,000 and the asset still `RESERVED`. `pickUp` → `PICKED_UP`, asset
`OCCUPIED`. `returnEquipment` → `INSPECTION` directly (skipping a
visible `RETURNED` state, as designed), asset `MAINTENANCE` — confirming
the equipment is genuinely off-market during inspection, not just
logically "returned" while still bookable. `completeInspection` →
`CLOSED`, asset back to `AVAILABLE`. Edge cases: pickup on an
already-`CLOSED` order 409s; `check-in` (the NIGHTLY-only method)
called on a DURATION_ORDER booking 400s with the explicit
"not implemented for DURATION_ORDER" message, confirming the two
verticals' lifecycle methods stay properly isolated from each other;
missing `endDate` on a DURATION_ORDER booking 400s; pickup attempted
before payment (booking still `APPROVED`) 409s
(`ILLEGAL_TRANSITION` — no `ACTIVATE` transition from `APPROVED` in
`durationOrderBookingFsm`, only from `PAID`). Ledger balance summed to
exactly 0.00 after the full flow and again after test-data cleanup.
`registry.test.ts` updated the same way Session 14 did for NIGHTLY —
DURATION_ORDER now joins it in the "working strategy, `computeFinalSettlement`
still a stub" test case instead of the old blanket "whole strategy
throws" one. Full `turbo run typecheck test build --force` passes clean
across all 8 packages (57 domain unit tests, up from 50).

**Session 16 (second-tenant onboarding — validated the extensibility
thesis, and found a real cross-tenant security bug doing it):**
Phase 3's last item on the original list, PRD §13: "a second tenant in
a different vertical onboarded without code changes." `packages/database/prisma/seed.ts`
now seeds two tenants — refactored into `seedStorageTenant()`
(`gudang-aman`, unchanged) and a new `seedHomestayTenant()`
(`griya-nginap`, NIGHTLY, deliberately **not** PKP-registered —
`isPkp: false` — to exercise `computeTax()`'s non-PKP branch on an
actually-running tenant, not just a unit test). Also retroactively
added `seedStaffUser()` and real `User`/`UserRole` rows for **both**
tenants (gudang-aman's `admin@`/`finance@` accounts existed only as
manual `psql` edits from earlier sessions, never committed anywhere —
a fresh clone of this repo had zero login-capable users until this
session; that gap is now closed). Demo password for every seeded
account: `RentOS!Demo2026` (bcrypt hash hardcoded in seed.ts, dev/demo
only). Verified live end-to-end against griya-nginap through real HTTP
— public catalog browse, booking submit, staff login + approve
(invoice correctly PPN-free per the non-PKP flag, invoice numbering
correctly namespaced `GRIYA-NGINAP/...`), OTP + mock payment, check-in,
check-out — with **zero application code changes**, only the new seed
rows. `gudang-aman`'s own catalog/assets/ledger were independently
confirmed untouched throughout.

**The real finding**: testing cross-tenant isolation with two *actual*
staff accounts (not just "no token" or single-tenant checks, which is
all any prior session had available) surfaced that a valid JWT for
tenant A, combined with an `X-Tenant-Slug: <tenant B>` header, could
read (and in some cases mutate) tenant B's data — confirmed live: a
`gudang-aman` staff token successfully fetched a `griya-nginap`
booking's full detail (200, real data) by simply changing the header.
Root cause: `TenantMatchGuard` (the guard whose whole job is rejecting
a session/header tenant mismatch) was **opt-in per-route**, and it had
quietly gone missing from roughly ten authenticated endpoints across
several modules — anywhere a handler used `@CurrentTenant()` (the raw
header-resolved tenant) without also listing `TenantMatchGuard`,
because `@CurrentTenantId()` handlers were incidentally safe already
(that decorator prefers `req.user.tenantId` from the JWT over the
header) while `@CurrentTenant()` handlers were not. Confirmed-vulnerable
before the fix: `BookingController.get`/`mine`/`pending`,
`DepositsController` in its entirety (**including its three mutating
routes** — `applyToDamages`, `requestRefund`, `approveRefund`),
`FinanceController.createCreditNote` (mutating), `CrmController.setBlocklist`
(mutating) and its list/get routes, `AgreementsController`'s
booking-access and file-download routes, `KycController.getFile`/`review`
(actual KTP/selfie PII, per PRD §10), `CatalogController.unitMap`
(occupant PII), and the entire `ReportingController` (occupancy,
AR-aging, month-end close, invoice/payment/ledger CSV export — a
tenant's whole financial picture).

**Fix**: rather than patch each call site (the exact failure mode that
created this gap — a convention documented in a comment, not enforced
in code), the tenant-match check was folded directly into
`JwtAuthGuard` itself (`apps/api/src/common/guards/jwt-auth.guard.ts`)
— it now overrides `canActivate` to run the passport JWT check first,
then compares `req.user.tenantId` against `req.tenant.id` exactly as
the old standalone `TenantMatchGuard` did, throwing the same
`ForbiddenException` on mismatch. Every authenticated route already
used `JwtAuthGuard`; none needed a new guard added. The standalone
`TenantMatchGuard` class and all its now-redundant `@UseGuards(...,
TenantMatchGuard)` call sites (`booking`, `payments`, `swap-requests`
controllers) were deleted rather than left as dead weight suggesting a
separate guard is still needed. A `PLATFORM_ADMIN` token
(`tenantId: null`) still bypasses the check by design, matching prior
behavior — that role isn't wired into any controller yet (Phase 4).
Re-ran the exact exploit after the fix: 403 (`"Session tenant does not
match the request domain."`). Spot-checked three more of the
previously-vulnerable routes (`/deposits`, `/catalog/assets/unit-map`,
`/reports/occupancy`) — all now 403 cross-tenant, still 200 same-tenant.
Full `turbo run typecheck test build --force` passes clean across all
8 packages with no regressions from the guard change.

This means **every prior session's live verification that used only
one tenant's staff token could not have caught this** — it's a direct,
concrete payoff of actually onboarding a second tenant with its own
real credentials, not just seeding more data under the same one.

**Session 17 (pooled inventory — `AssetType.isPooled` is now real):**
PRD §5.2's "pooled" flag existed in schema from Session 1 but nothing
ever read it — every booking assigned one specific `Asset` regardless.
New `packages/database/src/pooled-availability.ts`
(`computePooledAvailableCount`, `findAvailablePooledAsset`) implements
real date-range-overlap capacity math: available slots = in-service
units (excludes `RETIRED`/`MAINTENANCE`) minus bookings already
committed to an overlapping window, using the standard half-open
interval overlap test (`existing.startDate < windowEnd &&
existing.endDate > windowStart`). "Committed" status sets are
booking-model-specific (`NIGHTLY`: `PENDING_APPROVAL` through
`CHECKED_IN`; `DURATION_ORDER`: `PENDING_APPROVAL` through
`INSPECTION`) — terminal/dead statuses free the slot immediately.
Pooled `RECURRING_LEASE` is explicitly unsupported (an indefinite
lease has no window to overlap against) and throws a clear error if
ever configured, rather than silently doing the wrong thing.

`BookingService.createBooking` branches on `assetType.isPooled`: pooled
bookings validate capacity against the *real requested date range* and
leave `Booking.assetId` **null** — no specific unit is held at
submission, which is the entire point of a pool (two non-overlapping
bookings share the same physical inventory instead of the first one
locking a specific `Asset` for its whole lifecycle regardless of
dates). `BookingService.approve` is where a concrete unit first gets
attached: if the booking has no `assetId` and staff didn't pass one
explicitly, it auto-picks the lowest-code eligible unit via
`findAvailablePooledAsset` and reserves it (`assetFsm`
`AVAILABLE → RESERVED`) — a 409 if the pool is exhausted for those
exact dates by the time of approval (a real race is possible between
submission and approval; this is the correct place to catch it, not an
error). Everything downstream (check-in/check-out, deposit, ledger) is
completely unaffected — by approval time a pooled booking looks
identical to a non-pooled one, same `Asset` row, same FSM.
`CatalogService.availableCount` also branches on `isPooled`;
`GET /catalog/asset-types/:id/availability` gained optional
`startDate`/`endDate` query params (defaulting to "right now" — a
zero-length window — when omitted, e.g. the storefront asset-type page
shown before a customer picks dates) so pooled types can show a
real-ish "available now" figure. The number that actually gates a
booking is always recomputed against the customer's real requested
window at submission time; the display count is an estimate only.
Added `AssetType.isPooled` to `AssetTypeDtoSchema` (it existed in the
Prisma model and was already silently present in raw JSON responses,
just untyped for frontend consumers — a small, harmless gap closed in
passing). No storefront/console UI changes were needed — the existing
date-range booking form and asset-type detail page work unchanged for
a pooled type; only the backend's availability math is different.

Seeded a live demo: `griya-nginap` gained a third `AssetType`, "Dorm
Bed (Shared Room)" (`isPooled: true`, `NIGHTLY`, 2 physical beds
`BED-01`/`BED-02`) — a small pool deliberately, to make exhaustion easy
to exercise. Verified live: two bookings for the identical Aug 1-4
window both succeeded (`assetId: null` on both, pool has capacity 2);
a third for the same window correctly 409'd ("no units... available
for the requested dates"); a booking for a non-overlapping window
(Aug 10-12) succeeded even though the pool was "full" for Aug 1-4,
proving this is genuine date-range overlap logic, not a naive
total-booking-count check; a booking partially overlapping the full
window (Aug 3-6) correctly still 409'd. Approving both Aug 1-4
bookings auto-assigned them to the two different physical beds
(confirmed via response `assetId`s and both beds flipping to
`RESERVED`). Full pay → check-in → check-out on one of them correctly
walked its assigned bed through `RESERVED → OCCUPIED → AVAILABLE`,
identical to a non-pooled NIGHTLY booking. A regression check
confirmed non-pooled `Kamar Standard` bookings still get a specific
`assetId` immediately at submission, unchanged from before this
session. Ledger balance summed to exactly 0.00 after the full flow and
again after test-data cleanup. Full `turbo run typecheck test build
--force` passes clean across all 8 packages (no new unit tests this
session — `packages/database` has no vitest suite, consistent with
`ledger.ts`/`invoicing.ts`; correctness here is proven by live
verification against real overlapping bookings instead).

**Session 18 (seasonal/dynamic pricing — closes out Phase 3's named
PRD §13 list):** `AssetType.pricing.basePrice` was a single flat rate
regardless of date until this session. New
`packages/domain/src/pricing/seasonal.ts` (`computeNightlyRateBreakdown`,
`sumNightlyRateBreakdown`, 7 new unit tests) breaks a NIGHTLY stay into
contiguous rate groups from an optional `PricingConfig.seasonalRates`
array (`{startDate, endDate, basePrice, label}[]`, both dates inclusive
`YYYY-MM-DD` calendar strings — deliberately not ISO datetimes, so a
"season" is an unambiguous set of calendar dates, not a set of
instants tied to a timezone). A stay crossing a seasonal boundary
produces one `RENT` invoice line per contiguous rate run instead of a
single blended nights-×-rate figure, so the customer sees exactly
which nights cost what — e.g. "1 night × 650000" + "3 nights × 950000
— Christmas & New Year" rather than one opaque total. With no
`seasonalRates` configured this collapses to the exact same single
nights-×-rate line NIGHTLY has always produced — zero behavior change
for every AssetType that doesn't use the feature.

`buildInvoiceDraft` (`packages/domain/src/booking-model/invoice-builder.ts`)
was generalized to accept either one line or an array
(`InvoiceLineDraft | InvoiceLineDraft[]`) for its "primary lines"
parameter, normalizing internally — a deliberately non-breaking change
so `RecurringLeaseStrategy`/`DurationOrderStrategy`'s existing
single-line call sites needed zero edits; only `NightlyStrategy` now
passes an array. `PricingConfig` (domain), `PricingConfigSchema`
(contracts), and `toPricingConfig()` (`packages/database/src/invoicing.ts`)
all gained the optional `seasonalRates` field to thread it end to end.
Scoped to NIGHTLY only, matching the PRD's own framing ("needed for
hotel vertical," §7.2.3 P2) — DURATION_ORDER/RECURRING_LEASE are
untouched. No storefront/console UI changes were needed: the existing
date-range booking form and invoice line rendering already display
however many `RENT` lines an invoice has: this was a pure pricing-math
change with UI-visible effects, not a UI change.

Added a live demo: `griya-nginap`'s "Kamar Deluxe" `AssetType` gained a
Christmas/New Year seasonal rate (650,000 → 950,000/night,
Dec 24 – Jan 1). Verified live: a booking spanning Dec 23 → Dec 27
correctly produced two `RENT` lines — "1 night × 650000" (650,000) and
"3 nights × 950000 — Christmas & New Year" (2,850,000) — summing to
exactly 3,500,000 rent, hand-verified against the seasonal boundary by
inspection; full invoice total 3,925,000 (+25,000 admin fee +400,000
deposit, tax 0 since `griya-nginap` is non-PKP). A regression booking
on "Kamar Standard" (no `seasonalRates` configured) over the identical
date range correctly produced a single `RENT` line
(4 × 350,000 = 1,400,000), confirming zero behavior change for
non-seasonal AssetTypes. Ledger balance summed to exactly 0.00 after
both bookings and again after test-data cleanup. Full
`turbo run typecheck test build --force` passes clean across all 8
packages (72 domain unit tests, up from 65) — caught and fixed one
real gap in the process: a new test's array-indexing was only checked
by `tsc --noEmit`, not by `vitest run` (which transpiles without full
type-checking), so the turbo pipeline's dedicated `typecheck` step is
what actually caught it — a good illustration of why `turbo run
typecheck test build` runs all three, not just `test`.

This closes every named item on PRD §13's Phase 3 list.

**Session 19 (a third tenant, DURATION_ORDER — extending the
extensibility proof past its first data point):** Phase 3's named list
was already complete after Session 18; the user was asked whether to
start Phase 4 (explicitly optional, gated on a monetization decision
the owner deferred) or keep working within Phase 3's footprint, and
chose the latter. Of the three Phase-3-adjacent options on the table
(HOURLY_SLOT from scratch, pooled-inventory UI polish, a third
tenant), a third tenant was the best-scoped: `NIGHTLY` already had two
live tenants (Sessions 16, 18) and a second one would add no new
evidence, but `DURATION_ORDER` — fully built in Session 15 — had never
been exercised by a real tenant with its own credentials, only
throwaway `psql`-seeded test data cleaned up after each session's live
verification. `packages/database/prisma/seed.ts` gained
`seedEquipmentTenant()` (`sewa-alat`, an equipment-rental CV, PKP-registered
— a third real data point on the tax branch alongside `gudang-aman`'s
`true` and `griya-nginap`'s `false`): two `DURATION_ORDER` `AssetType`s
(genset, scaffolding), 4 assets, 2 staff logins, a demo customer, and
one order already `PICKED_UP` for the console/storefront to render on
first run — same structural pattern as `seedHomestayTenant()`.

Verified live end-to-end via real HTTP, zero application code changes:
public catalog browse → 4-day scaffolding order submitted → approved
(invoice math hand-checked: 4×90,000 rent + 15,000 admin fee = 375,000
taxable, 41,250 PPN since this tenant *is* PKP-registered, +750,000
deposit = 1,166,250 total, exact match) → OTP + mock payment → pickup
→ return (asset correctly routed through `MAINTENANCE` during
inspection, per Session 15's design) → complete inspection → `CLOSED`,
asset back to `AVAILABLE`. **The more important check**: with three
real tenants and three real staff credentials now live simultaneously,
re-ran Session 16's cross-tenant exploit pattern in every direction —
`gudang-aman`'s token against `sewa-alat`'s booking (403), `griya-nginap`'s
token against `sewa-alat`'s booking (403), `sewa-alat`'s token against
`gudang-aman`'s deposits list (403) and `griya-nginap`'s unit-map
(403), each tenant's token against its own data (200) — confirming the
`JwtAuthGuard` tenant-match fix (Session 16) holds correctly at N=3
tenants, not just the N=2 it was originally proven against. Public
catalogs stayed correctly isolated per tenant throughout (three
distinct asset-type lists, no cross-contamination). Ledger balance
summed to exactly 0.00 after the full flow and again after test-data
cleanup, checked across all three tenants combined. Full
`turbo run typecheck test build --force` passes clean across all 8
packages (no domain-package changes this session — this was a
database-seed + live-verification session, same shape as Session 16).

**Session 20 (Phase 4 kickoff — tenant-facing API + outbound webhooks):**
Self-directed the Phase 4 sub-feature choice (user said "let's move on to
phase 4, but only 1 tenant has it on the demo version" and explicitly
rejected an `AskUserQuestion` scoping prompt, so this session proceeded
without asking). Chose tenant-facing read API + outbound webhooks over
self-serve signup/billing/automation-builder/OTA-sync — best-bounded
engineering scope, reuses existing auth/RLS/BullMQ patterns, and fits
"one tenant only" as a `featureFlags.api_access_enabled` gate. Built:

- `TenantApiKey` / `TenantWebhookSubscription` / `TenantWebhookDelivery`
  (new RLS-covered tables, same `ENABLE`/`FORCE`/`CREATE POLICY` pattern as
  every other tenant-scoped table — `TenantApiKey` is deliberately **not**
  excluded from RLS like `tenants`/`tenant_domains` are, see the guard
  design below).
- `packages/contracts/src/platform-api.ts` — request/response schemas plus
  `WEBHOOK_EVENT_TYPES = ["booking.approved", "invoice.paid",
  "payment.received"]` as the single source of truth for valid event types.
- `WebhookDispatcherService` (`apps/api/src/webhook-dispatch/`) — a
  dedicated BullMQ producer (its own `IORedis` connection,
  `maxRetriesPerRequest: null`, separate from the existing OTP-tuned
  `RedisService`). `dispatch(tenant, eventType, data)` is a silent no-op
  unless the tenant has the feature flag AND an active matching
  subscription exists, so callers never gate it themselves — just call it
  unconditionally at the point the real event happens. Wired into
  `BookingService.approve` (`booking.approved`) and
  `PaymentsService.finalizePaidInvoice` (`invoice.paid` +
  `payment.received`, fired from the one method all three payment-finalize
  paths funnel through).
- `ApiKeysModule` / `TenantWebhooksModule` — console-facing CRUD,
  `SUPER_ADMIN`-only. Plaintext API key/webhook secret shown exactly once,
  at creation; list/get responses never include the key hash or secret
  (a real leak was caught and fixed during this session's own live
  verification — `ApiKeysService.list()` originally returned the raw
  Prisma row including `keyHash`; now uses an explicit `select`, matching
  the pattern `TenantWebhooksService` already used for its secret).
- `ExternalApiModule` — `GET /external/bookings` and `GET
  /external/invoices`, cursor-paginated, behind `ApiKeyGuard`.
- `apps/worker`'s `deliver-tenant-webhook.job.ts` — HMAC-SHA256 signs the
  payload with the subscription's secret, POSTs with a 10s timeout,
  records `httpStatus`/`error`/`attempt` on every try. Failure throws so
  BullMQ's `attempts: 5` + exponential backoff retries; the delivery row
  only flips to terminal `FAILED` once retries are exhausted (checked via
  `job.attemptsMade === job.opts.attempts` in the `Worker`'s `"failed"`
  handler), not on every transient failure.
- `apps/console/src/app/api-access` — key/subscription management +
  delivery-history view. Doesn't hide itself from tenants without the
  flag (console is one deployment per tenant anyway); shows a clear
  "not enabled for this tenant" message instead, backed by the real
  403 from the service layer.
- Seed: `gudang-aman` gets `featureFlags.api_access_enabled: true` (the
  other two tenants don't), a `SUPER_ADMIN` staff user
  (`superadmin@gudang-aman.test` — no tenant had one before this, since
  no prior module required it), a demo API key (`rok_demo_gudang_aman_2026`,
  fixed plaintext so it survives reseeding, same convention as
  `DEMO_PASSWORD_HASH`), and a demo webhook subscription pointing at the
  placeholder `https://example.com/webhooks/rentos` (deliberately
  non-functional — it exists so the console has something to show, not to
  actually deliver anywhere; see "Known shortcuts").

**Design decision — `ApiKeyGuard` and the RLS boundary**: the natural
question is how a request can be authenticated by API key before its
tenant is known, when RLS requires `app.tenant_id` set first. Rejected
excluding `TenantApiKey` from RLS (mirroring `tenants`/`tenant_domains`)
because that would reopen the exact unscoped-lookup risk surface Session
16's cross-tenant IDOR bug came from. Instead, `ApiKeyGuard` requires the
tenant already resolved by the existing `TenantMiddleware`
(`X-Tenant-Slug` header or Host — runs before every guard, for every
route) and looks the key up via `runInTenantContext(req.tenant.id, ...)`,
exactly like every other tenant-scoped query in this codebase. A caller
cannot probe whether a key exists under a tenant it didn't declare via
the header — verified live: a real `gudang-aman` key presented with
`X-Tenant-Slug: griya-nginap` gets the same 401 as no key at all (the
flag check fails first; even past that, the RLS-scoped lookup in
`griya-nginap`'s context would never see `gudang-aman`'s key row).

**Live verification** (real HTTP against local Postgres/Redis, plus a
throwaway local HTTP receiver on `:4500` for real webhook delivery):
`GET /external/bookings|invoices` with a valid key → 200 with real,
RLS-scoped data; invalid key → 401; revoked key → 401; valid key +
wrong `X-Tenant-Slug` → 401 ("not enabled", since the other two tenants
don't have the flag); no key → 401. Created a live booking, approved it
(`booking.approved` delivered to the local receiver, HTTP 200,
`X-RentOS-Signature` independently recomputed in Python and matched
byte-for-byte), then paid its invoice (`invoice.paid` and
`payment.received` both delivered, both signatures verified). The seeded
placeholder subscription to `https://example.com/webhooks/rentos` failed
and retried as expected — that's the intended behavior of a demo
placeholder URL, not a bug. `griya-nginap`/`sewa-alat` both correctly
rejected external-API calls regardless of key validity (flag off).
Ledger balance summed to exactly 0.00 across all three tenants
throughout, and again after test-data cleanup (temp asset, customer,
booking, invoice, payment, ledger entries, and the verification-only
webhook subscription/API key were all deleted — the seeded demo key and
demo subscription were left in place). Full
`turbo run typecheck test build --force` passes clean across all 8
packages (note: this environment's shared `.env` sets
`NODE_ENV=development`, which breaks Next.js's static `/404` prerender
with an unrelated `<Html> should not be imported outside of
pages/_document` error — build with `NODE_ENV=production` explicitly, a
pre-existing environment quirk unrelated to this session's changes, not
a regression).

**Also caught mid-session**: re-running `seed.ts` against an
**already-seeded** database does not retroactively apply new
`Tenant.featureFlags` keys — `tenant.upsert`'s `update: {}` is a
deliberate no-op on existing rows (see the file's own top comment: it
never overwrites a tenant that already exists), so `api_access_enabled`
only lands via the `create` branch on a genuinely fresh database. This
local environment's DB predated the seed.ts edit, so the flag had to be
patched in directly via SQL to unblock verification. Not a bug in the
upsert pattern itself (retroactively overwriting tenant state on every
reseed would be worse — it'd clobber real config changes made through
the console), just something to know: **a fresh `docker compose up` +
first-ever seed run gets this correctly out of the box; an
already-seeded local DB from a prior session does not** and needs either
a fresh DB or a manual flag patch.

**Session 21 (Phase 4 continued — automated KYC verification):** Continued
self-directing Phase 4's remaining sub-features per the pattern
established in Session 20 (pick the most engineering-bounded remaining
item, document the reasoning, keep it demo-limited to one tenant). Chose
automated KYC verification — PRD explicitly names it ("Verihubs or
similar") and scopes it to P2, and it fits the existing
Payment/Messaging/Storage/ESign **provider-port pattern** exactly, unlike
self-serve signup/billing/the automation builder/OTA sync, which are all
either bigger or more business-shaped. Built:

- `KycDocument.verificationSource` (`MANUAL`/`AUTO` enum) +
  `providerRef`/`providerReason` columns (migration, no new RLS needed —
  `kyc_documents` was already RLS-covered).
- `KycVerificationProvider` port (`apps/api/src/kyc/kyc-verification-provider.interface.ts`)
  — `MockKycVerificationProvider` (zero-config default, always
  `VERIFIED`, mirrors `MockESignProvider`'s "just works" behavior) and
  `VerihubsKycVerificationProvider` (real-but-unconfigured, needs
  `VERIHUBS_API_KEY`/`VERIHUBS_APP_ID`, selected via
  `KYC_VERIFICATION_PROVIDER=verihubs`). **Known simplification**: Verihubs
  calls are per-document (KTP OCR-validity for a KTP upload, liveness
  check for a SELFIE upload), not the true KTP-vs-selfie face-match
  Verihubs also offers — `KycService.upload()` verifies each document as
  it lands, not as a matched pair, so face-match isn't reachable without
  a bigger change to that call site. Documented in the provider's own
  comment.
- `KycService.upload()` calls the provider immediately when
  `tenant.featureFlags.kyc_auto_verification_enabled` is on;
  `VERIFIED`/`REJECTED` settle the document right away (no staff
  involved), `PENDING` (provider inconclusive) falls back to the
  existing manual queue with the provider's reason attached for staff
  context. `KycService.review()` (staff manual review) always resets
  `verificationSource` back to `MANUAL` — a human decision supersedes
  whatever automation said, even overriding an already-AUTO-decided
  document. Both paths share one `recomputeCustomerStatus` helper so the
  hasKTP/hasSelfie/anyRejected/allVerified logic can't drift between
  them.
- `apps/console/src/app/kyc/page.tsx` — shows the provider's reason on
  any document that auto-checked but came back inconclusive (the only
  case an AUTO-attempted document still reaches this manual queue).
- Seed: `sewa-alat` gets `featureFlags.kyc_auto_verification_enabled: true`
  — deliberately a *different* tenant than Session 20's `gudang-aman`,
  to demonstrate the per-tenant feature-flag mechanism generalizes
  rather than being hardcoded to one specific tenant. `griya-nginap`
  doesn't even have `kyc_required` on, so it wasn't a meaningful target
  for this flag regardless.

**Live verification**: uploaded a KTP for a `sewa-alat` customer → came
back `VERIFIED`/`AUTO` immediately, no staff action; uploaded the
matching SELFIE → also auto-`VERIFIED`, and the customer's `kycStatus`
flipped to `VERIFIED` **automatically**, with neither document ever
appearing in the staff review queue. Confirmed `gudang-aman` (flag off)
is byte-for-byte unchanged — a KTP upload there still lands
`PENDING_REVIEW`/`MANUAL` exactly as before this session. Staff then
manually overrode the auto-verified KTP to `REJECTED` — `verificationSource`
flipped to `MANUAL`, `reviewedByUserId` populated, and the customer's
`kycStatus` correctly cascaded to `REJECTED` (original `providerRef`/
`providerReason` preserved as a historical record of what the automated
check originally said, not wiped by the override). Ledger balance
unaffected (KYC never touches it) — confirmed still 0.00 for
`gudang-aman`, zero entries for the other two. Full
`turbo run typecheck build test --force` passes clean across all 8
packages. Test customers/documents cleaned up afterward; the flag
itself stays on for `sewa-alat`.

**Also hit the same seed-upsert gotcha as Session 20**: `sewa-alat`
already existed in this local DB, so `featureFlags.kyc_auto_verification_enabled`
needed a manual SQL patch to actually land, exactly like
`api_access_enabled` did. Same non-bug, same fix — noted here so it's
not repeated as a surprise a third time. A fresh database's first seed
run needs no such patch.

**Session 22 (Phase 4 continued — OTA channel calendar sync via iCal):**
Third self-directed Phase 4 sub-feature, same pattern as Sessions 20/21.
Chose OTA calendar sync — PRD §13 names it ("OTA channel sync (hotel)")
and it's the last remaining item that's engineering-bounded rather than
business-shaped (self-serve signup, billing/metering, and the automation
builder all remain undone — see "Resume here"). Specifically built it as
**iCal (.ics) sync**, not a paid OTA API integration: real self-hosted
rental platforms commonly sync Airbnb/Booking.com/VRBO this way because
it needs no API credentials or business-development relationship with
the OTA, just an exchange of plain calendar URLs — which also means
there's no "real-but-unconfigured provider" stub here the way
Xendit/WhatsApp/Privy/Verihubs work, since the whole mechanism is an
open, credential-free standard, not a paid third-party API.

- `OtaCalendarSubscription` (one per Asset — one real-world listing = one
  physical unit = one external calendar) + `OtaBlockedDate` (parsed
  VEVENTs, deduped by external UID) — new RLS-covered tables.
- `packages/database/src/ical.ts` — hand-rolled RFC5545 VEVENT
  generator (outbound) and a deliberately minimal VEVENT extractor
  (inbound): no `RRULE`/recurrence, no `VTIMEZONE`, whole-day `VALUE=DATE`
  only. A real "block these reserved nights" export feed is always a
  flat list of non-recurring VEVENTs in practice, so a full RFC5545
  parser would be a lot of unused complexity — same reasoning as this
  codebase's hand-rolled FSM over xstate.
- `packages/database/src/ota-blocking.ts` — `findAvailableNonPooledAsset`,
  extending the pre-existing non-pooled asset-selection query (which had
  **no date-overlap check at all** before this session — a single-
  current-booking-per-asset simplification already in place) to also
  exclude any Asset with an overlapping `OtaBlockedDate`. Only wired in
  for NIGHTLY — the one booking model OTA sync targets.
- `OtaSyncModule` — `GET /ota/assets/:assetId/calendar.ics` (public,
  unauthenticated, gated by `featureFlags.ota_sync_enabled`, exposes only
  date ranges, never customer PII — same trust level as public catalog
  browsing) + `SUPER_ADMIN`-gated subscription CRUD. Registering a
  subscription only stores *what* to sync — apps/worker's new hourly
  `sync-ota-calendars` job does the actual fetching/parsing, so a slow or
  unreachable external URL never blocks an API request.
- **`TenantMiddleware` gained a `?tenant=<slug>` query-param fallback**
  (checked after the `X-Tenant-Slug` header, before Host) — needed
  because the outbound .ics URL is meant to be pasted directly into
  Airbnb/Booking.com's calendar-import field, and an OTA's fetcher can't
  be configured to send a custom header the way `apps/storefront`/
  `apps/console`'s own BFFs can. This is a small, general-purpose
  addition (any future unauthenticated endpoint needing a URL-embeddable
  tenant hint benefits from it), not something scoped narrowly to OTA
  sync.
- `apps/console/src/app/ota-sync` — lists every Asset's outbound feed URL
  (copyable) and manages inbound subscriptions with last-sync status.
- Seed: `griya-nginap` gets `featureFlags.ota_sync_enabled: true` (the
  only NIGHTLY/homestay tenant — the one vertical OTA sync targets) plus
  a `SUPER_ADMIN` staff user and one demo subscription pointing at a
  placeholder URL (same non-functional-by-design convention as Sessions
  20/21's demo credentials). **All three tenants now each demonstrate a
  distinct Phase 4 capability**: `gudang-aman` → API/webhooks,
  `sewa-alat` → automated KYC, `griya-nginap` → OTA sync.

**Live verification**: fetched `gudang-aman`'s D-01 outbound feed (both
via `X-Tenant-Slug` header and via `?tenant=` query param, simulating a
real external OTA fetcher) and got a correct `VEVENT` matching its real
seeded `CHECKED_IN` booking's exact dates. Stood up a throwaway local
HTTP server serving a fixed test .ics (one VEVENT blocking Aug 10-15,
2026), registered it as a real subscription against two of
`griya-nginap`'s Kamar Standard units (R-01 and R-02 — the only two
`AVAILABLE` units of that type), ran the sync job directly (not waiting
for the hourly schedule) and confirmed the parsed `OtaBlockedDate` rows
landed with the exact UID/dates from the feed. Then: a booking attempt
for Aug 11-13 (inside the blocked range) on Kamar Standard correctly
409'd ("No units of this type are currently available") since both
candidate units were blocked; a booking attempt for Sept 1-4 (outside
the range) on the same AssetType correctly succeeded and landed on R-02
— proving the exclusion is genuinely date-range-scoped, not a blanket
asset lockout. `gudang-aman` and `sewa-alat` (flag off on both) correctly
403'd on the outbound feed regardless of asset id. The seeded placeholder
subscription failed/retried as expected (non-functional by design, same
as Sessions 20/21's demo credentials). Ledger balance unaffected
(0.00, and OTA sync has no financial code path to begin with). Full
`turbo run typecheck build test --force` passes clean across all 8
packages (built with `NODE_ENV=production`, same pre-existing environment
quirk noted in Session 20). Test subscriptions, the test booking, and its
customer were all cleaned up afterward; the seeded demo subscription and
`ota_sync_enabled` flag were left in place.

**Environment note, unrelated to this session's code**: partway through
this session, both the local Postgres and Redis services stopped
running (likely a container/resource event, not something any command
here caused) — `pg_isready`/`redis-cli ping` both failed mid-session and
had to be restarted with `sudo service postgresql start` /
`sudo service redis-server start` before verification could continue.
If a future session hits `ECONNREFUSED`/"no response" on either despite
`.env` being correct, check whether the services are simply not running
before assuming a config problem.

**Session 23 (Docker verification attempt + catalog setup UI):** Two
things, not one Phase-4 feature — Phase 4's three remaining named items
(self-serve signup, billing/metering, the automation builder) are all
business-shaped decisions per Session 22's own note, so this session
didn't touch them; instead it (1) re-attempted Docker build verification,
flagged as unverified debt since Session 1, and (2) built the first
console UI to create/edit a tenant's own catalog, a real long-standing
engineering gap unrelated to any Phase 4 business decision.

**Docker verification — still blocked, confirmed again, not a config
issue**: Docker CLI (29.3.1) and daemon are present in this sandbox; the
`service docker` init script itself fails silently (a `ulimit` permission
error swallowed by the script), but running `dockerd` directly works
fine, including with the session's proxy env vars explicitly passed
through (`sudo HTTPS_PROXY=... HTTP_PROXY=... dockerd`). `docker pull
node:22-alpine` still gets a `403 Forbidden` from
`production.cloudfront.docker.com` — the exact same failure documented
since Session 1, now confirmed to persist even with the daemon correctly
proxy-aware. Per the agent-proxy's own README (`/root/.ccr/README.md`):
"403/407 from the proxy: destination not allowed by org egress policy...
do not retry or route around it." This is a policy block, not something
fixable from inside a session — **stop attempting Docker builds in this
environment** until the policy changes; the Dockerfiles themselves are
unverified but were never the suspected problem.

**Catalog setup UI (`apps/api/src/catalog/`, `apps/console/src/app/catalog-setup/`)**:
every `AssetType`/`Asset` row in this codebase was seed-data-only (or a
direct `psql` edit) through Session 22, called out repeatedly as a real
gap since Session 1. Added the first write path: `POST`/`PATCH
/catalog/asset-types` (name, pricing, `isPooled`, `isPublished` —
`bookingModel`/`slug` are set once at creation and never editable
afterward, since a booking's FSM and every downstream lifecycle
assumption is keyed off `bookingModel`), `POST /catalog/assets` (add a
unit under an AssetType), `PATCH /catalog/assets/:id/status` (manual
status override, blocked while an asset is tied to an active booking).
All four are `SUPER_ADMIN`/`OPS_ADMIN`-gated — no per-tenant feature flag
needed here, since this isn't a premium/optional capability the way
Sessions 20-22's Phase 4 slices were, it's baseline tenant operations
that should exist for everyone. `apps/console/src/app/catalog-setup` —
list/create/edit AssetTypes with a real pricing form (base price, admin
fee, deposit rule, tax-inclusive toggle) and add units under them.

**Live verification**: logged in as `gudang-aman` staff, created a new
`AssetType` via the API (not seed data), edited its pricing (raised the
base price, flipped `taxInclusive` on), confirmed it appeared in the
*public* (unauthenticated) storefront catalog with the edited pricing,
added a unit under it, then ran a real booking end-to-end through that
brand-new unit: submit → approve → invoice generated. The invoice's tax
math was hand-verified correct for the tax-inclusive edit (PPN backed
out of a 1,010,000 taxable base — rent + admin fee — as 100,090.09, not
added on top), proving a console-created AssetType is fully
production-equivalent to a seed-data one, not a second-class path.
Confirmed `FINANCE_ADMIN` (no `OPS_ADMIN`/`SUPER_ADMIN`) gets a real 403
from every new write endpoint. Ledger stayed at 0.00 throughout. Full
`turbo run typecheck build test --force` passes clean across all 8
packages. Test AssetType/Asset/booking/invoice/customer were all cleaned
up afterward.

**Real bug found and fixed during this session's own live
verification, unrelated to this session's code changes**: logging in as
`admin@gudang-aman.test` with the documented demo password failed —
its stored `password_hash`, and separately `finance@gudang-aman.test`'s,
did not match `RentOS!Demo2026` at all (verified with a direct
`bcrypt.compareSync`), while every other seeded staff account across all
three tenants did. These two accounts were created in Session 1, before
`DEMO_PASSWORD_HASH` in `seed.ts` apparently reached its current value —
`seedStaffUser`'s upsert never overwrites an existing user's
`passwordHash` (`update: {}`), so this went unnoticed for 22 sessions
since nothing in that stretch happened to log in as either account
directly. Patched via direct SQL (same fix pattern as the seed-upsert
feature-flag gotcha) to the correct hash for `RentOS!Demo2026`. If a
fresh database's first seed run ever produces a similar mismatch, it
would mean `DEMO_PASSWORD_HASH` itself is wrong, not this same
already-diagnosed staleness issue — worth a quick sanity check
(`bcrypt.compareSync("RentOS!Demo2026", DEMO_PASSWORD_HASH)`) if a whole
tenant's logins ever fail identically on a fresh environment.

**Session 24 (invoice numbering race-condition fix):** Continued the
Session 23 pattern of picking up engineering debt while Phase 4's three
remaining named items stay parked on a business decision. Fixed
`nextInvoiceNumber`'s long-flagged race (present since very early
sessions, called out in the function's own doc comment every session
since): it derived the sequence from `tx.invoice.count(...)` inside the
same transaction as invoice creation, so two invoices for the same
tenant/month "created simultaneously" could read the same count before
either committed and both compute the same next number. **Correction to
what earlier sessions assumed**: `Invoice` already has `@@unique([tenantId,
invoiceNumber])` (missed in a quick earlier grep this session before
reading the schema properly) — so the race was never a silent duplicate
tax-compliance bug, it was a hard `P2002` constraint-violation crash on
one of the two concurrent requests. Real, but less severe than initially
assumed; still worth fixing since a random transaction failure under
concurrent load is a genuine reliability bug.

- New `InvoiceNumberCounter` model (RLS-covered, `@@unique([tenantId,
  year, month])`) — one row per tenant per month, holding the running
  counter.
- The migration backfills each tenant/month's starting counter from the
  count of invoices already on record for that period, so the switch
  doesn't collide with already-issued numbers on this (or any other)
  already-seeded database.
- `nextInvoiceNumber` (`packages/database/src/invoice-number.ts`) now
  runs a single `INSERT ... ON CONFLICT (tenant_id, year, month) DO
  UPDATE SET counter = counter + 1 RETURNING counter` — Postgres's own
  row-level lock on the conflicting key serializes concurrent callers,
  so there's no read-then-write window left to race in. No application-level
  locking, no retry loop, no advisory lock needed — the database does the
  serialization for free as part of a single atomic statement.

**Live verification**: confirmed the migration's backfill counter
(9) exactly matched `gudang-aman`'s real existing invoice count for the
current month. Fired 25 truly concurrent calls to `nextInvoiceNumber`
directly (`Promise.all` against the pooled `PrismaClient`, so genuinely
parallel connections, not sequential awaits) — all 25 numbers came back
unique and correctly sequential (`000010` through `000034`, continuing
right after the backfilled `9`), zero constraint violations. Then
exercised the real call site end-to-end through the actual API (OTP
login → submit booking → staff approve → invoice generated) and
confirmed it picked up exactly where the concurrency test left off
(`000035`) — proving the real production code path uses the same fixed
counter, not just the isolated function in a unit-test-style check.
Ledger stayed at 0.00 throughout; full `turbo run typecheck build test
--force` passes clean across all 8 packages. Test invoices/bookings from
verification were deleted afterward — their consumed sequence numbers
were deliberately left as permanent gaps rather than decrementing the
counter back down, matching how real tax-compliant sequential numbering
is supposed to behave (a voided/deleted invoice still burns its number,
never gets reused).

**Session 25 (documentation-integrity audit, no application code changes):**
Continued Sessions 23/24's pattern of picking up engineering debt while
Phase 4's three remaining named items stay parked on a business
decision, but this time the "debt" was HANDOFF.md itself. After 24
sessions of incremental feature work, this file's own "What's
explicitly NOT done" section had drifted from reality in three places —
each one checked against actual code, not assumed:

- Automated KYC verification was still described as "v1 review is 100%
  manual, by design" — wrong since Session 21's `KycVerificationProvider`
  port shipped (`sewa-alat` runs it live).
- The unit map was still described as "list view only" — wrong since
  Session 9; `apps/console/src/app/assets/page.tsx` has had a real
  grid/list toggle the whole time.
- Swap/upgrade requests were still described as "schema exists, zero
  application logic" — wrong since Sessions 10/13, which built the full
  request/approve/reject flow with computed mid-cycle proration and
  storefront/console UI.

Corrected all three in place, with a strikethrough-style annotation
naming which session actually closed each gap, so a future session
doesn't have to re-derive this. Also split promo codes/duration
discounts out from the swap-requests bullet they'd been lumped into —
confirmed via `grep` that `PromoCode` genuinely has zero application
logic in `apps/api`, so that part of the old bullet was still accurate
even though the swap-requests part it was bundled with wasn't. Fixed a
smaller drift in "Known shortcuts": the shared-demo-password bullet
still said "both tenants" from before a third tenant existed (Session
19); now says "all three," with a pointer to Session 23's stale-password-hash
bug for context on the one real exception to "one password fits all."

**Why this matters as its own unit of work, not just a typo fix**: this
file is the *only* continuity mechanism across context resets — a
future session has no way to independently notice a claim here is wrong
short of the same kind of manual grep-and-verify pass this session did.
An incorrect "NOT done" claim is worse than no claim at all, since it
actively steers a future session away from work that's already
finished (or, worse, toward redoing it). No code changed this session;
`turbo run typecheck build test` was not re-run since nothing it checks
was touched — the standing per-session verification step doesn't apply
usefully to a docs-only diff.

**Methodology, for the next time this file needs the same treatment**:
for each claim in "What's explicitly NOT done" and "Known shortcuts,"
grep for the feature by name before trusting the prose — the three
wrong claims here had each been sitting unchallenged for anywhere from
4 to 16 sessions after the code that disproved them landed. Worth
another pass like this periodically, not just when a claim happens to
get noticed by accident (which is how Session 24 found the
`nextInvoiceNumber` entry was stale — this session made the check
deliberate instead of incidental).

**Session 26 (closes out Phase 4 — self-serve signup, tenant billing/
metering, and a scoped-down automation builder, all under explicit user
authorization):** The user's own words: "authorized, self serve, billing
and automation builder, implement it only in one user as a form of
demo." This directly overrides the standing pattern from Sessions 20-25
of treating these three items as business decisions to defer — the user
made the business call, so this session built all three, real and
live-verified, deliberately demo-scoped rather than opened to every
tenant/user.

**The "one user" interpretation**: rather than gating each feature to
one more tenant (the Session 20-22 pattern), self-serve signup and
billing are inherently platform-level — they need exactly one privileged
account that spans tenants, not a per-tenant flag. The schema already
had a designed-but-unused seam for this: `User.tenantId` is nullable
with a doc comment reading "null => platform admin," and the original
`enable_rls` migration's own comment on the `users` table read "rows
with a NULL tenant_id (platform-admin scope) are only reachable via the
owning/migrator role until a dedicated platform-admin path ships
(tracked in docs/HANDOFF.md, PRD Phase 4 territory)." This session built
exactly that path, for exactly one seeded account
(`platform-admin@rentos.test`, same demo password as everyone else). The
third item, the automation builder, doesn't need platform-wide reach at
all — it's a per-tenant setting by nature — so it stayed in the
established Sessions 20-22 pattern: one feature flag, one tenant
(`gudang-aman`, chosen because it doesn't yet demonstrate a distinct
Phase 4 capability of its own beyond Session 20's API/webhooks, and now
does).

**Self-serve tenant signup** (`apps/api/src/platform/`,
`packages/contracts/src/platform-admin.ts`): `POST /platform/signup` is
genuinely public — no guard, no platform-admin auth required — because
that's the actual point of "self-serve": anyone with the API URL can
create a new tenant + its first `SUPER_ADMIN` user in one call
(company name, slug, PKP flag, admin name/email/password). Deliberately
does **not** ask for a booking-model/vertical at signup — there's
nowhere consequential for that answer to go yet (Tenant has no
"vertical" field, and inventing one to hold an otherwise-unused value
felt like exactly the kind of unnecessary field the project's own
conventions warn against); the admin picks their vertical implicitly by
which `AssetType.bookingModel` they create first, via Session 23's
`/catalog-setup`, after logging in. `PlatformService.signup` creates the
`Tenant` row via `PrismaService.raw` (unprotected, like every tenant
resolution lookup) then the first user via the ordinary
`runInTenantContext(newTenant.id, ...)` path — no RLS changes needed for
this half, since a fresh tenant writing its own first row is exactly
what that mechanism is for. **Verified live**: signup created a real
`demo-coworking` tenant; its `admin@demo-coworking.test` /
`DemoPass123!` credentials logged in for real via the ordinary
`POST /auth/console/login` (`X-Tenant-Slug: demo-coworking`) and correctly
saw an empty catalog (fresh tenant, zero data leakage from other
tenants); the existing Session 16 cross-tenant guard held against this
brand-new tenant too (a request combining this new tenant's token with
`X-Tenant-Slug: gudang-aman` correctly 403'd — proof the guard's
protection is structural, not something that had to be specifically
extended for a signed-up-not-seeded tenant); duplicate slug correctly
409'd; malformed slug correctly 400'd. Deleted the test tenant afterward
(cascade) to keep "three tenants are live" the stable documented
baseline — the signup *mechanism* is what's meant to persist as proven,
not that one specific test tenant.

**Platform-admin auth** (`apps/api/src/auth/auth.service.ts`'s
`platformLogin`, `packages/database/src/platform-context.ts`): the real
engineering center of this session. A platform-admin `User` row has
`tenant_id IS NULL`, which the *existing* per-tenant RLS policy
(`tenant_id = current_setting('app.tenant_id', true)::uuid`) can never
match — `NULL = anything` is `NULL`, never `TRUE`, in SQL — so it was
genuinely unreachable by `rentos_app` (no `BYPASSRLS`) before this
session, exactly as the original migration's comment predicted. Fixed
by adding one narrow OR-branch to the `users` table's policy only (new
migration `20260719055422_add_platform_billing`): a NULL-tenant_id row
also becomes visible when a new session var, `app.platform_admin`, is
set to `'true'` — which only `withPlatformContext()` (mirroring
`withTenantContext()`'s shape exactly: `SET LOCAL` via
`set_config(...)`, so it's real string-parameterized, not interpolated)
ever sets, and only `AuthService.platformLogin` ever calls, for the one
purpose of looking up a platform admin by email at login. No other
table's policy changed; no other code path can read a NULL-tenant_id
row. `JwtAuthGuard` needed **zero changes** — it already special-cased
`req.user.tenantId === null` as "skip the tenant-match check" since
Session 16, for exactly this not-yet-built role. The issued JWT carries
`tenantId: null, roles: ["PLATFORM_ADMIN"]`; `RolesGuard`'s existing
`@Roles("PLATFORM_ADMIN")` check needed no changes either. **Verified
live**: correct credentials log in; wrong password 401s; a real tenant
staff account's credentials (`admin@gudang-aman.test`) correctly 401 on
`/auth/platform/login` (no cross-pollination between the two login
paths); a valid tenant-staff JWT correctly 403s on `/platform/tenants`
(RolesGuard); no token at all correctly 401s.

**Tenant billing/metering** (`packages/domain/src/billing/plans.ts`,
`packages/database/src/platform-billing.ts`, new `PlatformInvoice`
model): a real, if intentionally simple, usage-based SaaS billing model
— four static plans (TRIAL/STARTER/GROWTH/SCALE, hardcoded price +
included-asset-count lookup table in code, not a DB table, same
reasoning `LedgerAccount` is an enum not a table: a short closed list
nothing but this code ever queries) plus a flat per-asset overage charge
past the included count. **Deliberately one metered dimension** (active,
non-`RETIRED` `Asset` count) instead of a multi-metric bill — the
simplest thing that's still genuinely usage-based, not a placeholder
flat fee, and consistent with this project's repeated preference for
the real-but-narrow implementation over a general one nothing here
needs yet. `computeMonthlyCharge` (5 new unit tests) is a pure function,
called from `generateMonthlyPlatformInvoices`
(`packages/database/src/platform-billing.ts`, same
apps/worker+apps/api shared-orchestration pattern as
`invoicing.ts`) which loops tenants via `withTenantContext` (RLS gives
no other option — `rentos_app` has no cross-tenant query, by design) and
upserts one `PlatformInvoice` per tenant per calendar month, idempotent
via the `[tenantId, periodYear, periodMonth]` unique constraint. Wired
into **both** a real monthly BullMQ repeatable job
(`apps/worker/src/jobs/platform-billing.job.ts`, 1st-of-month) **and** an
on-demand `POST /platform/billing/run` trigger for the platform-admin
console (waiting for a real monthly cron tick isn't demoable in one
session) — both call the exact same shared function, so they can't
drift into two implementations. `POST /platform/billing/invoices/:id/mark-paid`
lets the platform admin simulate collecting payment (`ISSUED → PAID`,
idempotency-guarded — marking an already-`PAID` invoice 409s).
**Deliberately does not touch any tenant's own ledger** — this is
RentOS's own AR against the tenant, a completely different set of books
from what `packages/database/src/ledger.ts` tracks (a tenant's revenue
from *its* customers); see `PlatformInvoice`'s doc comment in the schema
for the explicit "these are not the same books" note, and see "Known
shortcuts" below for what that leaves unbuilt (RentOS has no ledger for
its own revenue at all, v1). **Verified live**: billing run generated
one `TRIAL`-plan (free) invoice per tenant, matching each tenant's real
asset count (all under `TRIAL`'s 10-asset allowance, so overage math
wasn't exercised at nonzero scale live — it *is* covered by the unit
tests, including the exact-at-the-limit boundary and the "usage below
allowance" case); re-running the same month's billing correctly created
nothing new (`created: false` for all four tenants, including the
just-signed-up demo tenant); mark-paid flipped status and set `paidAt`;
a second mark-paid attempt correctly 409'd. Ledger balance
(`ledger_entries`, the tenant-facing one) summed to exactly 0.00
debits-credits both before and after the entire billing run, confirming
the "these are separate books" boundary actually held in practice, not
just in the doc comment.

**Automation builder** (`apps/api/src/automation/`,
`packages/contracts/src/automation.ts`, `apps/worker/src/jobs/dunning-ladder.job.ts`):
scoped down from "visual automation builder" to a structured settings
editor for the one automation the PRD actually describes in enough
detail to build precisely — the dunning ladder (§8.4 A5/A6: day offsets
relative to due date, a suspend threshold). Not a general condition/
action rule canvas; see the contracts file's own doc comment for the
reasoning, which follows the same "build the real narrow thing, not a
generic engine nothing needs yet" pattern as the hand-rolled FSM and the
hand-rolled iCal parser elsewhere in this codebase.
`AutomationService.get`/`upsert` read/write one `AutomationSetting` row
per tenant (key `DUNNING_LADDER`), gated by
`featureFlags.automation_builder_enabled` (on for `gudang-aman` only) —
`GET` returns the hardcoded platform default with `isDefault: true` when
no row exists yet, so the console form always has something sensible to
show. `dunning-ladder.job.ts`'s three previously-hardcoded constants
(`REMINDER_DAYS_BEFORE_DUE`/`OVERDUE_REMINDER_DAYS`/`SUSPEND_AFTER_DAYS_OVERDUE`)
are now only the *fallback*, read via a new `resolveDunningLadderConfig`
per tenant per run — an enabled, well-formed saved row wins; anything
else (no row, disabled, malformed JSON) falls back to exactly the old
hardcoded behavior, so every tenant without the flag gets zero-regression
identical behavior to every prior session. **Verified live, and this is
where the session found something worth flagging**: proving the wiring
actually works required understanding `dunning-ladder.job.ts`'s
pre-existing (not touched this session) `daysUntilDue` sign convention
precisely — `daysBetween(dueDate, today) * -1` means a due date *N days
in the future* yields `daysUntilDue = -N`, and a due date *N days in the
past* yields `daysUntilDue = +N`. This reads backwards from the
"H-7/H-3/H-0" naming's intuitive meaning (a naive reading expects a
future due date to produce a positive "days until due"), but it's
internally consistent with the code as written and this session did not
change it — flagging it here explicitly (and in "Known shortcuts" below)
specifically so a future session doesn't "fix" what might be a working,
if confusingly-signed, existing behavior without first checking whether
anything downstream depends on the current sign. With that convention
understood: an `ISSUED` test invoice manufactured 5 days *before* its
due date (`daysUntilDue = +5`, present in the custom `[5, 2, 0]` ladder
saved for `gudang-aman` but *absent* from the hardcoded default `[7, 3,
0]`) correctly fired `invoice_reminder_h5` — proof the worker read the
saved per-tenant override, not the hardcoded fallback. The identical
scenario on `griya-nginap` (no `automation_builder_enabled` flag, no
saved row) correctly fired **nothing** for `h5`/`d5` — proof the
fallback path is untouched for every tenant without the feature. Console
role/flag gates verified too: a `griya-nginap` staff token 403's on
`/automation/dunning-ladder` (flag off); a `gudang-aman` `FINANCE_ADMIN`
token 403's (role not in `SUPER_ADMIN`/`OPS_ADMIN`); a `gudang-aman`
`OPS_ADMIN`/`SUPER_ADMIN` token can read and save. Test invoices and
their notifications were deleted after verification; the saved
`gudang-aman` `AutomationSetting` row itself was deliberately **left in
place** (not test cruft — it's the actual demo state proving the
feature persists, same convention as Session 20's demo API key/webhook
subscription).

**Full `turbo run typecheck test build --force` passes clean across all
15 tasks** (8 packages, 70 domain unit tests including the 5 new billing
ones). One real build-time bug caught and fixed during this pass, not
present in the final commit: `apps/console/src/lib/platform-api.ts`
initially imported `"./api.js"` (the `.js`-suffixed-import convention
`apps/api`/`packages/database` use under `tsc`'s Node-ESM resolution) —
`tsc --noEmit` didn't catch it (Next's `tsconfig.json` uses bundler
resolution, which is more permissive), but `next build`'s webpack pass
did, with a clear "Module not found" pointing at the exact file. Fixed
by dropping the extension to match every other `@/lib/*` import in this
app — a good reminder that `tsc --noEmit` alone is not equivalent to
`next build` for catching this class of resolution mismatch in a mixed
Node-ESM/bundler-resolution monorepo.

**Session 27 (RECURRING_LEASE Daily/Weekly rateTier — Travelio-style short
stays):** User-requested feature, not a PRD item: the storefront's
move-in date was locked to the indefinite monthly lease with no shorter
option. Deliberately scoped as **fixed-term bookings**, not a cadence
change to the indefinite lease — a real architectural fork (confirmed
with the user before building): Daily/Weekly bookings get a real
`endDate` and one upfront invoice (rate × duration, reusing the exact
NIGHTLY/DURATION_ORDER pattern), not a switch to daily/weekly recurring
billing. This avoided reworking `periodEndFor`/`nextAnchorDate` (the
month-anchor proration engine dunning, swap-request proration, and the
recurring-invoice cron all depend on) — the larger, riskier alternative.

New `RateTier` (`DAILY`/`WEEKLY`/`MONTHLY`, default `MONTHLY`) on
`Booking` (`packages/database/prisma/migrations/20260719084110_add_rate_tier`)
and `PricingConfig.dailyRate`/`weeklyRate` (`packages/domain`).
`RecurringLeaseStrategy.computeInitialInvoice` branches on
`window.rateTier`: `MONTHLY` is the pre-existing anchor-date-prorated path,
byte-for-byte unchanged (13 new unit tests confirm zero regression, plus
a same-inputs-with/without-tier equivalence test); `DAILY`/`WEEKLY` charge
`dailyRate × days` / `weeklyRate × ceil(days/7)` with no proration, the
same shared `buildInvoiceDraft` tax/deposit assembly every other strategy
uses. Fixed-term bookings never get an `anchorDay`
(`BookingService.finalizeActivation` only sets one for `MONTHLY`) — that's
what excludes them from the recurring-invoice worker job's
`anchorDay: { not: null }` query with zero changes needed there.
`BookingService.giveNotice` explicitly 400s for fixed-term bookings
("has a fixed end date... contact support to modify") rather than letting
`computeFinalSettlement`'s month-anchor math silently misfire against a
booking that was never on that cadence — **known v1 shortcut**: nothing
auto-closes a fixed-term booking at its `endDate`; staff terminate
manually via existing tools, same "known shortcut, not a bug" pattern as
Session 10's swap-request proration.

New public `GET /catalog/asset-types/:id/quote` (`CatalogService.quote`)
reuses `computeInitialInvoice` read-only (no persistence) so the
storefront's live price preview can never drift from the real charge —
exported `toPricingConfig` from `@rentos/database` rather than
hand-duplicating the JSON→PricingConfig parsing a second time. Console's
Catalog Setup gained optional Daily/Weekly rate fields (RECURRING_LEASE
only, blank = tier hidden on the storefront). Storefront's `BookingForm`
gained a Daily/Weekly/Monthly tab picker (only shown when the AssetType
has at least one of those rates configured), a duration-count input
(days for Daily, weeks for Weekly) that computes the checkout date
client-side, and a live quote panel wired to the new endpoint.

Full `turbo run typecheck build --force` passes clean across all 8
packages. `packages/domain` test suite: 78 tests, 75 passing (the 13 new
ones for this session all pass) — 3 pre-existing failures in
`test/seasonal.test.ts` (NIGHTLY seasonal-rate breakdown, unrelated to
this session) confirmed present on a clean stash of the prior commit
before this session touched anything; not investigated further here,
tracked as a pre-existing gap for a future session.

**Verified live against the deployed Railway environment** (`gudang-aman`,
real Postgres, not local): set `dailyRate`/`weeklyRate` on the real seeded
"Storage Unit 1.5×2m" AssetType via `PATCH /catalog/asset-types/:id` →
`GET .../quote` for all three tiers matched the unit tests' hand-derived
math exactly (DAILY 3 days: 315,300 total; WEEKLY 9 days→2 weeks:
1,182,500; MONTHLY unchanged: 763,306.45 prorated) → submitted a real
`POST /bookings` with `rateTier: DAILY` — booking correctly got a real
`endDate` and `anchorDay: null` → approved as `superadmin@gudang-aman.test`
→ the generated invoice's lines/total matched the quote byte-for-byte,
confirming the "preview can't drift from the real charge" guarantee
actually holds, not just in theory. Storefront's asset-type page confirmed
rendering the new "/day"/"/week ... also available" pricing hint via the
live server-rendered HTML. Test booking left in place (not deleted) as a
concrete example — id `d007931d-e7e4-4537-807b-092301b07937`.

**Session 28 (PRD v2 — self-storage booking flow, approval pipeline,
waitlist, magic links, term payment schedules, AR horizons, client list;
spec in `docs/PRD-v2-storage-flow.md`):** User-directed, the first
post-roadmap feature build, scoped to `RECURRING_LEASE` tenants only —
NIGHTLY/DURATION_ORDER paths are byte-for-byte untouched (re-verified:
`griya-nginap` approve still generates the invoice immediately and lands
in the workbench's Finance column; the Session 16 cross-tenant guard
still 403s). Four decisions were confirmed with the owner before building
(PRD v2 §2): monthly payment schedules for 1/3/6/12-month terms (not one
upfront invoice); the blackout month blocks *other* customers only (the
occupant can extend); Google/Clerk customers get **email instead of
WhatsApp**; Leaflet + OpenStreetMap for the branch map. Everything else
the PM decided alone is listed in PRD v2 §3 so it can be overturned.

What changed, by layer:

- **Schema** (`20260822030000_v2_storage_flow`, hand-written — see the
  sandbox note below): `BookingStatus.WAITLISTED`; `CustomerChannel`;
  `Location.latitude/longitude`; `Customer.phone` **nullable** +
  `preferredChannel` + `clerkUserId` + unique `(tenantId, email)`;
  `Booking.locationId/termMonths/extendsBookingId/kycRequestedAt/
  contractGeneratedAt/waitlistedAt`; `Invoice.scheduleIndex/documentUrl`;
  `Contract.unsignedDocumentUrl`; new RLS-covered
  `customer_access_tokens` (magic links, SHA-256 hashed, 30-day,
  multi-use, revocable).
- **Domain** (`packages/domain`, 78 → 122 tests): `pricing/term-schedule.ts`
  (full-month periods from the start day, clamped month-ends, proforma
  due = min(issue+7d, move-in)), `availability/blackout.ts`
  (`isUnitFreeFor` — both sides' hold windows `[start, end + blackout)`
  must not overlap; the booking being extended is exempt for its own
  customer), `crm/customer-health.ts` (the owner's healthy/risky/overdue/
  inactive rule), `finance/ar-aging.ts` (`bucketReceivables`: overdue
  buckets + coming-due buckets inside a horizon), `comms/templates.ts`
  (bilingual ID/EN email copy per templateKey + `buildMagicLinkUrl`,
  shared by api and worker). `RecurringLeaseStrategy` gained the term
  proforma (`window.termMonths` → FULL first month, no proration) and
  `computeCycleInvoice(periodStart, periodEnd)`; the legacy indefinite
  path is unchanged (a regression test pins the 16/31 proration). FSM:
  `DRAFT -WAITLIST-> WAITLISTED -OFFER_UNIT-> PENDING_APPROVAL`,
  `WAITLISTED -REJECT/EXPIRE->`, `ACTIVE|RENEWING|SUSPENDED -TERM_ENDED->
  MOVED_OUT`.
- **Database** (`packages/database`): `storage-availability.ts` — the
  date-range engine. **`Asset.status` is now only the physical floor
  state** for storage; bookability comes from committed bookings'
  hold windows. **Ended leases (MOVED_OUT/CLOSED) still count** — the
  blackout month runs from the end date, and a bug where LARGE showed
  "1 of 1 available" the day after its term ended was caught by a
  storefront screenshot, not a test; a legacy lease with no endDate uses
  its notice date / updatedAt so it can't hold a unit forever.
  `invoicing.ts`: `persistInvoiceCore` can now create **SCHEDULED**
  invoices (provisional number `SCHEDULED/<booking8>/<k>`, no ledger) and
  `issueScheduledInvoice` assigns the real tax-sequential number + posts
  the accrual entries on issue (idempotent); `generateTermPaymentSchedule`
  builds #0 (ISSUED proforma) + #1..N-1 (SCHEDULED); `voidScheduledInvoices`
  for early termination / term end. `magic-link.ts` mints/exchanges tokens.
  `client.ts` gained an **opt-in** `PRISMA_DRIVER_ADAPTER=pg` path (pg
  driver adapter + Prisma's bundled WASM engine) — the default native-
  engine path is unchanged; `previewFeatures = ["driverAdapters"]` in the
  generator is harmless for production.
- **API**: `BookingService.createBooking` forks by booking model —
  storage goes through `createStorageBooking` (branch + term required,
  `DAILY`/`WEEKLY` now 400 "no longer offered", date-range availability,
  **WAITLISTED instead of 409** when full, soft-reserve only if the unit is
  physically free today); dated verticals keep `createDatedBooking`
  verbatim. Pipeline stage is **derived** (`booking-pipeline.util.ts`,
  P2) from status + `kycRequestedAt` + customer `kycStatus` + whether
  invoice #0 exists — the FSM was not forked per stage. New endpoints:
  `GET /bookings/pipeline`, `POST /bookings/:id/request-kyc`,
  `/generate-contract` (contract row + PDF via pdfkit + full schedule +
  proforma PDF, fires the `booking.approved` tenant webhook *here* for
  term leases since that's when an invoice exists), `/offer-unit`;
  `GET /catalog/availability`, `/catalog/locations/:id/asset-types`,
  `POST/PATCH /catalog/locations`; `POST /auth/magic/exchange`,
  `POST /auth/clerk/exchange` (`@clerk/backend`, lazy-loaded, 503 without
  `CLERK_SECRET_KEY`); `GET /customers/clients(+/:id)`; `GET /reports/
  ar-aging?asOf&horizonDays`; `GET /invoices/:id/pdf`, `GET /contracts/:id/
  document`. `NotificationsService.notifyCustomer` routes by
  `preferredChannel` with an `EmailProvider` port (`console_log` default,
  `resend` coded-unconfigured) and injects a magic link as
  `variables.link`; `OptionalJwtAuthGuard` lets a signed-in customer's
  booking attach to their account. Customers can now only read their own
  booking/invoice (`GET /bookings/:id`, `/invoices/:id` — a pre-existing
  gap closed in passing).
- **Worker**: `issue-scheduled-invoices` (daily 00:45, issues SCHEDULED
  cycles on their `issueDate`, ACTIVE → RENEWING, notifies with a pay
  link) and `term-lifecycle` (daily 00:30: PENDING_APPROVAL past
  `reservedUntil` → EXPIRED — **PRD §8.1's 48h TTL, documented since
  Session 1, enforced for the first time**; term end → MOVED_OUT + void
  leftover SCHEDULED; notice date → MOVED_OUT). The legacy anchor-date
  generator now only serves `termMonths: null` leases. `notify.ts`
  mirrors the API's channel routing + magic links.
- **Storefront**: `/` is the branch picker (Leaflet, inline-SVG pins,
  browser geolocation → "Closest to you" + km) for tenants with any
  `RECURRING_LEASE` type, the v1 catalog otherwise; `/locations/:id`
  (S/M/L cards from `attributesSchema.sizeClass`, live counts);
  `/locations/:id/:assetTypeId` (`StorageBookingForm`: live availability
  + schedule preview, "Join the waitlist" when full); `/m/:token`
  (magic-link landing, same-origin `next` only); `/login` gains "Continue
  with Google" via `@clerk/clerk-react` **only when
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is set** (no Clerk middleware —
  purely client-side, exchanged for our JWT); portal shows the payment
  schedule, contract/proforma PDFs, term-aware early termination.
  `/asset-types/:id` redirects storage types to `/`.
- **Console**: `/bookings` is a five-column pipeline board (Waitlist /
  Awaiting approval / Request KYC / Contract + proforma / Finance) with
  one primary action per card; `/reports` gained as-of + 30/60/90 AR
  aging and, directly below the export buttons, the client list
  (`ClientList`, also at `/clients`, detail at `/clients/:id` with
  rentals + schedules, deposits, KYC, message log); `/catalog-setup`
  swaps the daily/weekly fields for size class + m² and adds branch
  create/edit with coordinates (the `Location` write path flagged as a
  gap since Session 1); booking detail shows pipeline actions, schedule,
  contract PDF, timeline.

**Verified live** (local Postgres/Redis, real RLS role, `scripts/smoke-v2.sh`
from a freshly reset + seeded DB): branch/size catalog → 3-month quote
(rent 450,000 = a full month, 3-row schedule) → availability → LARGE
booked on C-01 → second LARGE request WAITLISTED #1 → availability
blocked at the previous end date and free one month later → DAILY tier
400 → approve lands in KYC stage with no invoice → generate-contract
409s before KYC → request-KYC mints a magic link → exchanging it twice
logs in without OTP → KTP + selfie verified → CONTRACT stage → generate
contract + proforma (real PDFs, `%PDF` checked; proforma 6,019,000 =
2,800,000 + 100,000 + 319,000 PPN + 2,800,000 deposit; cycles 3,108,000;
only the proforma posted to the ledger) → AR aging 90-day horizon shows
the two scheduled cycles as coming due → mock payment → ACTIVE, unit
OCCUPIED → client list HEALTHY with next due → waitlist offer-unit 409s
while the unit is taken, reject works → ledger 9,238,000 = 9,238,000.
Worker, time-travelled: cycle 1 issued as `…/000002` + RENEWING, second
run a no-op, term end → MOVED_OUT + leftover cycle VOID + C-01 AVAILABLE
yet **unbookable today, bookable in 40 days** (blackout after move-out),
stale request → EXPIRED + A-01 released; ledger 12,346,000 = 12,346,000.
Storefront and console screenshotted in headless Chromium (OSM tiles
can't load in this sandbox — egress — but pins, distances and the
"Closest to you" badge render). `turbo run typecheck test build --force`
green across all 15 tasks (122 domain tests).

**Sandbox note (why there are new scripts/)**: this session's egress policy
blocked `binaries.prisma.sh`, so `prisma generate`/`migrate` could not
download engines. `scripts/migrate-deploy-psql.sh` applies migrations
with psql and records them in `_prisma_migrations` exactly like Prisma
(a later real `prisma migrate deploy` on Railway sees nothing to do),
and `scripts/prisma-wasm-loader.mjs` + `PRISMA_DRIVER_ADAPTER=pg` run the
app on Prisma's bundled WASM engine. `turbo.json` passes the `PRISMA_*`
vars through. The v2 migration was therefore **hand-written** (Prisma
conventions followed); `prisma migrate dev` was never run against it —
if a future session has engine access, `prisma migrate diff` against the
schema is a cheap sanity check.

**Deploying this**: Railway builds `@rentos/api` from
`claude/rentos-platform-build-www4ou` on push, with **no automatic
migration step** — this branch (`claude/rentos-v2-storage-flow`) was
deliberately not merged there. Before merging: run the migration, set
`STOREFRONT_BASE_URL` (or a real primary `TenantDomain`) so magic links
point at the real storefront, and optionally `EMAIL_PROVIDER=resend` +
`RESEND_API_KEY`/`EMAIL_FROM` and the two Clerk keys.

### What's explicitly NOT done (don't assume it exists)

**Re-audited in Session 25 — three bullets below were stale/wrong** (automated
KYC and unit-map-grid claims described pre-Session-9/21 reality; swap
requests were lumped in with genuinely-unbuilt promo codes). Read this
list itself with some skepticism going forward — a quick `grep` for the
feature in question is cheap insurance against repeating this.

- ~~Per-tenant `AutomationSetting` rows are schema-only — the dunning ladder hardcodes its steps uniformly, doesn't read tenant config~~ — **wrong since Session 26** for `gudang-aman` specifically (`featureFlags.automation_builder_enabled`, `apps/api/src/automation/`, live-verified worker wiring). Still true for every other tenant, by design — the hardcoded steps remain the correct fallback for anyone without the flag, not a gap to close.
- Invoice-payment refunds (as opposed to deposit refunds) — no endpoint; `PaymentProvider.refund()` is only called from the deposit-refund flow today (`apps/api/src/deposits/deposits.service.ts`, the only call site). Still accurate as of Session 25.
- **Promo codes and duration discounts** — `PromoCode` exists in the schema with zero application logic anywhere in `apps/api` (confirmed via grep, Session 25). Genuinely unbuilt, unlike swap/upgrade requests below.
- ~~Platform admin console (multi-tenant switcher, tenant provisioning wizard, self-serve signup) — still doesn't exist~~ — **wrong since Session 26**. `POST /platform/signup` is a real, public, self-serve tenant-creation endpoint; `apps/console/src/app/platform/*` is a real multi-tenant platform-admin console (tenant list, billing, signup wizard), gated to one demo `PLATFORM_ADMIN` account. What's still true: it's not a "switcher" in the sense of one login seeing/acting as multiple tenants' *consoles* — the platform console is read/admin-only over cross-tenant summaries, not a way to operate inside a specific tenant's own console without that tenant's own staff credentials. That's a real, narrower gap than "doesn't exist," not the same claim.
- Real Xendit/WhatsApp Cloud credentials — adapters are coded against the real APIs but unconfigured; `PAYMENT_PROVIDER=mock` / `MESSAGING_PROVIDER=console_log` is what actually runs today. Same is true of Session 21's `VerihubsKycVerificationProvider` (`KYC_VERIFICATION_PROVIDER=mock` is the default), Session 28's `ResendEmailProvider` (`EMAIL_PROVIDER=console_log` default) and Clerk Google sign-in (hidden/503 without keys).
- **Per-tenant WhatsApp Business API setup from the console** (Session 28 explicitly deferred it per the owner: "pending WhatsApp automation… needs to be able to setup via console") — credentials are still process-wide env vars, not `Tenant`-scoped.
- **Term extension from the portal** — `Booking.extendsBookingId`, the blackout exemption for the parent booking, and `POST /bookings` accepting `extendsBookingId` (customer session required) are all built and unit-tested; there is no portal button yet.
- **Automatic waitlist promotion** when a unit frees up — staff-driven "Offer unit" only; nothing notifies the waitlist on its own.
- **Per-tenant document templates** — the contract/proforma PDFs are one fixed pdfkit layout (bilingual), not the PRD §7.2.7 placeholder templates.
- The `WAITLISTED` state exists only for `RECURRING_LEASE`; NIGHTLY/DURATION_ORDER still 409 when full.
- **Docker builds were never actually executed in this sandbox** — Docker Hub registry access is blocked by this environment's egress policy (`production.cloudfront.docker.com` returns 403, an org policy denial per the agent-proxy's own README, not a config problem — re-confirmed in Session 23 with the daemon correctly proxy-aware). The Dockerfiles follow standard, well-established patterns (Turborepo `prune --docker`, Next.js `output: standalone`) and `turbo prune` itself was verified working locally, but nobody has run `docker build` or `docker compose up` against them. **Validate this first** in any environment with real registry access before trusting it blindly — and don't re-attempt it in this sandbox, it's a policy block, not a transient failure.

**Corrected — these are actually done, despite older phrasing here claiming otherwise:**
- ~~Automated KYC verification — v1 review is 100% manual, by design~~ — **wrong since Session 21**. Real automated verification exists (`KycVerificationProvider` port, `MockKycVerificationProvider`/`VerihubsKycVerificationProvider`), gated per tenant by `featureFlags.kyc_auto_verification_enabled`, on for `sewa-alat` only. Manual review is still the default for tenants without the flag — that part of the original claim holds, just not universally.
- ~~Unit map — list view only~~ — **wrong since Session 9**. `apps/console/src/app/assets/page.tsx` has a real grid/list toggle (`view === "grid"`), grouping units into rows by their code's leading letters as a pragmatic floor-layout stand-in.
- ~~Swap/upgrade requests — schema exists, zero application logic~~ — **wrong since Sessions 10/13**. Full request/approve/reject flow with computed mid-cycle proration and storefront/console UI. (Promo codes and duration discounts, bundled in the same old bullet, are still genuinely unbuilt — split out above.)

---

## Resume here


### Which spec wins (read before planning any storage work)

`docs/BUILD-SPEC.md` (9 Aug 2026, from the July client meetings) says it
supersedes `docs/PRD.md` — that means PRD **v1**. `docs/PRD-v2-storage-flow.md`
(22 Aug 2026, decisions confirmed with the owner) is NEWER than both and is the
live spec for the `RECURRING_LEASE` storefront, approval pipeline and finance
views. Precedence for storage work:

> **PRD v2 > BUILD-SPEC > meeting transcripts > PRD v1 > HANDOFF**

BUILD-SPEC still governs everything PRD v2 does not speak to — C1 Organization
above Tenant, C2 role x scope RBAC, RLS, the org-read path.

Where the two overlap, the reconciliation actually built is:

- **Terms vs RentalOrder (C4).** PRD v2 D1 wins for billing: a term is 1/3/6/12
  months and its whole payment schedule is materialised at contract time. The
  C4 H-14 confirmation gate is kept but fires ONCE, before the term expires —
  inside a signed term the customer already committed, so a per-month gate is
  redundant; at the boundary it is what keeps the agreement closed-ended.
- **Waitlist (C5 vs P3).** WaitlistEntry stays the mechanism (queue position,
  asset row lock, payment TTL — the double-booking protections P3 did not
  have). The Booking still carries `WAITLISTED` so there is one customer
  record and one message trail, which is what P3 was actually after.

> ### ⛔ READ FIRST — `docs/BUILD-SPEC.md` now supersedes the PRD (Session 20)
>
> A new source of truth landed: **[`docs/BUILD-SPEC.md`](./BUILD-SPEC.md)** — the
> *Infrastructure & Remediation Build Spec (v2.0)*. It is derived from two client
> meeting transcripts that happened **after** `docs/PRD.md` was written, and it
> establishes this precedence: **BUILD-SPEC > meeting transcripts > PRD > HANDOFF**.
> Where the PRD and BUILD-SPEC disagree, BUILD-SPEC wins.
>
> **The headline:** five of the PRD's foundational assumptions are wrong, and the
> codebase (Phases 0–4) was built faithfully against them, so the corrections are
> **schema-breaking, not cosmetic**:
> - **C1** — Tenant should equal one *location/branch*, under a new **Organization**;
>   today it's `Tenant → Location[]` (the opposite shape). HO needs read-across-tenants
>   via a *separate* `app.organization_id` session var, read paths only — never widen
>   `app.tenant_id`.
> - **C2** — Six client roles = **role × scope** (`BaseRole × RoleScope`, `tenantIds[]`),
>   not six enum values. Authoritative matrix: **[`docs/RBAC.md`](./RBAC.md)**.
> - **C3** — Monthly only. Gate `DAILY`/`WEEKLY` behind a per-tenant flag (off); a
>   non-integer month count must throw, not round. Keep proration only in swap requests.
> - **C4** — Renewal is a **new closed-ended contract gated on H-14 confirmation**
>   (`RentalOrder`), not a silent recurring-invoice job against one long-lived Booking.
> - **C5** — Waitlist is an **armed conditionally-approved booking** that auto-issues
>   contract+invoice on release, with a single-fire row lock and a payment TTL.
>
> **Do NOT start remediation R1 until the §7 blocking decisions (B1–B10) are closed.**
> Several are client-owned (Maverick, Ko Yudi, the client's lawyer) and cannot be
> answered from code — see BUILD-SPEC §7. The phased plan is **R0 → R4** in §8, each
> with a handoff gate that requires *recorded evidence against real Postgres/Redis*
> (match the ledger-balance standard). Companion authoritative docs also landed:
> **[`docs/RBAC.md`](./RBAC.md)**, **[`docs/LEGAL-ESIGN.md`](./LEGAL-ESIGN.md)** (§5
> e-sign cost architecture + B3 lawyer sign-off record), and
> **[`docs/RUNBOOK-BACKUP.md`](./RUNBOOK-BACKUP.md)** (#50 — the backup answer the
> client asked for and never got).
>
> **Session 20/21 status (2026-08-09): §7 decisions CLOSED, R0 done + verified, R1
> built + core-verified.** The client answered B1–B10 (see BUILD-SPEC §7) and
> authorized R1–R4. This sandbox turned out to HAVE local Postgres 16 + Redis, so
> the schema/RLS work was verified live (unlike the egress-blocked prior sessions).
> See the **"Session 20/21 — Remediation R0 + R1"** log entry below for the full
> evidence and the precise remaining-work list (R2 finance/e-sign, R3 comms/ops/
> backup, R4 UI). Longest-lead external dependency remains **Meta business
> verification** (NPWP/NIB + ~2 days) — start it now. Everything below the session
> log describes the pre-spec state (PRD Phases 0–4) and remains accurate as prior
> context.
>
> **Verification quick-reference (re-runnable):**
> ```
> # from repo root, with local PG (rentos db, postgres trust) + rentos_app role:
> export DATABASE_URL=postgresql://postgres@localhost:5432/rentos?schema=public
> export DATABASE_URL_APP=postgresql://rentos_app:changeme_in_production@localhost:5432/rentos?schema=public
> pnpm --filter @rentos/database exec prisma migrate deploy   # 8 migrations, clean
> pnpm --filter @rentos/domain test                           # 109 tests
> psql -h localhost -U postgres -d rentos -f packages/database/scripts/rls-verify.sql  # C1 RLS
> JWT_SECRET=x pnpm --filter @rentos/database exec tsx apps/api/scripts/waitlist-fire-verify.ts  # C5 single-fire
> ```

### Session 20/21 — Remediation R0 + R1 (2026-08-09)

**What's proven (live against local Postgres 16 + Redis):**

- **C1 (org → tenant + org-read RLS).** New `organizations` table, `Tenant.organizationId`,
  `Location`/`Asset.locationId` made optional. Cross-tenant HO reads go through a
  SEPARATE `app.organization_id` session var + a `FOR SELECT` `org_read` policy
  (migration `20260809120100`), OR'd with `tenant_isolation` for reads only — the
  write `WITH CHECK` is never widened. Hardened `tenant_isolation` to a NULL-tolerant
  cast (`20260809120200`) so a reused pooled connection with no tenant context returns
  zero rows, not a `uuid: ""` error. `withOrgReadContext()` added to `@rentos/database`
  (mirror of `withTenantContext`, read-only). **Evidence:** `packages/database/scripts/rls-verify.sql`
  as `rentos_app` — tenant A sees only A; no-context = 0 rows; org scope sees BOTH
  branches' full financials (B2); org UPDATE of non-active tenant = 0 rows; INSERT into
  non-active tenant = RLS violation.
- **C2 (role × scope RBAC).** `UserRole` is now `{ role: BaseRole, scope: RoleScope, tenantIds[] }`.
  Authoritative capability matrix is **pure code in `packages/domain/src/rbac/capability-matrix.ts`**
  (single source; `docs/RBAC.md` mirrors it; `apps/api/src/auth/rbac/capability.matrix.ts`
  re-exports). New `@RequireCapability` + `CapabilityGuard` (+ `StaffGuard`); all 10
  controllers converted off `@Roles`/`RolesGuard` (both deleted). JWT carries
  `organizationId` + `roleAssignments`. **Maker-checker preserved verbatim** — the guard
  only grants the *right* to verify. **Evidence:** `packages/domain/test/rbac.test.ts`
  (23 tests: every matrix cell + the four denials + scope).
- **C2 user administration (the "set up the hierarchy" surface).** `UsersService` +
  `UsersController` (`/users` — list/create/update-role/set-status), all `manage_users`
  gated, plus the console **`/settings/users`** page (admin-only nav; org-scoped admins
  see every branch and can grant ORGANIZATION scope, branch admins see only their branch).
  Two guards enforced + verified (`apps/api/scripts/users-admin-verify.ts`): (1) WRITES
  stay single-tenant — users are created in the console's active tenant (a Super Admin
  switches branches to add elsewhere), org admins only LIST across the org (read-only);
  (2) NO privilege escalation — a branch Admin is blocked from granting an ORGANIZATION
  role. Console builds clean (`/settings/users` in the route manifest).
  > **Known follow-up (regression from the R0 RBAC rename):** other console pages
  > (e.g. `deposits`) still gate action buttons on the OLD flat role names
  > ("SUPER_ADMIN"/"OPS_ADMIN"/"FINANCE_ADMIN"), which the API no longer returns
  > (`user.roles` now holds base roles ADMIN/FINANCE/SUPERVISOR/STAFF). Those buttons
  > will not render for anyone until each page is updated to the base roles /
  > capabilities. The API still enforces correctly; this is UI-gating only. Fix as part
  > of the R4 console pass. The new `/settings/users` page and `ConsoleShell` already use
  > the base-role helpers (`isAdmin`/`isOrgScoped` in `lib/auth-client.ts`).
- **C3 (monthly-only).** `monthly-guard.ts`: `wholeMonthsBetween`/`assertWholeMonths`
  throw `NonIntegerMonthError`; `assertBillingUnitAllowed` gates DAILY/WEEKLY behind
  `featureFlags.allowSubMonthly` (off). Rental-order invoices are whole-month, no proration.
- **C4 (RentalOrder + renewal).** `RentalOrder`/`RentalOrderEvent`/`OrderAcceptance` +
  FSM (`rental-order-fsm.ts`). `RentalOrderService`: create (customer picks TYPE+months,
  not a unit — #11), approve (assign unit + issue mock-signed contract + first invoice
  incl. deposit), markPaidAndActivate (two-gate), offerRenewal (H-14), confirmRenewal
  (spawns successor in the renewal chain), declineRenewal (release + fire waitlist).
  Worker: `renewal-offer.job` (H-14), `renewal-timeout.job` (B1: H-7 no-reply → decline
  → release → fire).
- **C5 (waitlist).** `WaitlistEntry` + `waitlist-rules.ts` (pure) + shared
  `fireNextWaitlistEntry()` in `@rentos/database` (single source used by the API service
  AND the worker jobs — no drift). Single-fire via `SELECT ... FOR UPDATE` on the asset.
  Worker: `waitlist-expiry.job` (hourly TTL sweep → void + EXPIRED + fire next).
  **Evidence:** `apps/api/scripts/waitlist-fire-verify.ts` — two concurrent fires on one
  released unit → exactly 1 order/1 contract/1 FIRED/1 ARMED, asset RESERVED, **ledger
  balanced** (DEBIT=CREDIT).
- **#30/#31/#32 pricing** (`pricing/discounts.ts`): bundle + duration + manual override,
  composed base→bundle→duration→override. Tested (`discounts.test.ts`).
- Seed rewritten: City Storage org + 1 mockup branch (B8) + the six role×scope users +
  catalog + signed master agreement + one active rental order.
- **8 migrations apply clean via `prisma migrate deploy`, zero drift; 109 domain tests
  pass; all 7 packages typecheck.**

**What is NOT done yet (remaining R2–R4, precise):**

- **R2 — finance controls + e-sign.** DONE + verified: **§5 master agreement +
  order-acceptance (OTP) + Mekari adapter** (`esign-cost-verify.ts`: 1 certified sig,
  3 OTP orders, 0 extra certs); invoice **void #33** (`invoice-void-verify.ts`,
  ledger-balanced); manual **price override #32**; **backdate #34** (`backdate-verify.ts`:
  original VOID + superseded link, replacement ISSUED for shifted period, ledger
  balanced — no pile-up). All SPV-gated. Also DONE: **bulk export by month**
  (#37) — `GET /reports/export/contracts.csv` (contracts + order/booking + customer +
  sign status); the actual PDF-zip is deferred until real signed docs exist (today's
  contracts are MockESign-signed, no bytes). **R2 backend is complete.** Mekari stays
  behind `MockESignProvider` until `MEKARI_*` keys land (`ESIGN_PROVIDER=mekari`).
- **R3 — comms/ops.** DONE + verified: **backup + restore-verify** (#50 —
  `infra/backup/dump.sh` + `restore-verify.sh`; drill PASS, ledger balanced on the
  restored copy; RUNBOOK §8 log) and the **forward-occupancy calendar** (#47 —
  `ReportingService.forwardOccupancy` + `GET /reports/forward-occupancy`, renewal-aware
  per #17; live-checked against seed). Also DONE: **dunning retune to
  H-7/5/3/1 dual-recipient (#41/#42)** — `dunning-ladder.job` now reminds the customer
  AND the branch admin (`tenant.featureFlags.adminNotifyRecipient`), each with its own
  dedupe; `notify()` carries `recipientRole`. Also DONE: **branch onboarding
  (#45, backend)** — `OrganizationService.provisionBranch` + `POST /organization/branches`
  creates a new empty branch under the org (org-scoped admin only); clean-slate
  migrate+seed re-verified. STILL TO DO: org-level single WA number (#40 — the current
  single-env-credential design already means one number for all branches;
  `Organization.messagingConfig` is the override seam, not yet resolved by the provider);
  the onboarding wizard's *console UI*; Railway backup scheduling + object-storage upload;
  Railway security brief (#51); Google OAuth (#2 — needs real OAuth creds/flow).
  Also DONE: **business multi-number (#3) at the service layer** —
  `CrmService.getOrCreateByPhone` resolves a customer by the canonical phone OR any
  VERIFIED `CustomerPhone`, plus `addPhone`/`confirmPhone`/`listPhones`; the OTP-confirm
  wiring into auth + the portal add-number UI remain. Individual/business fields
  (#4 — `Customer.type`/`companyName`/`taxId` columns exist; the conditional form is
  storefront UI). **Remaining is now essentially R4 UI + external integrations (Google
  OAuth, real WA/Mekari keys) + Railway ops wiring.**
- **R4 — UI + launch.** Mobile-first storefront (#49), remove unit selection UI (#11 —
  backend already ignores customer unit choice), console screens for the new
  rental-order/waitlist/renewal/org-switcher flows, staff training, cutover. No Next.js
  UI was changed this session.
- **Verification gaps to close next:** a scripted end-to-end renewal chain over two
  consecutive periods; availability query renewal-awareness (#16/#17); full NestJS API
  e2e boot (this session verified via RLS SQL + domain tests + the waitlist concurrency
  script + typecheck, not a running API).

**Local infra note:** this sandbox runs Postgres 16 (`/usr/lib/postgresql/16`, cluster
under `/home/pg/pgdata`, unprivileged `pg` user, port 5432, trust auth) + Redis. The
`rentos_app` role is created by the `enable_rls` migration. Docker/Railway still
unverified (unchanged from prior sessions).

---

**Phase 2 is complete. Phase 3 is complete** — every named item on PRD
§13's Phase 3 list is done: NIGHTLY (Session 14) and DURATION_ORDER
(Session 15) real logic, pooled inventory (Session 17), seasonal
pricing (Session 18), and a second tenant in a different vertical
onboarded with **zero application code changes** (Session 16) — the
PRD's core extensibility thesis is validated with real evidence, not
just a clean interface. Session 16 also closed a real cross-tenant
security gap that every single-tenant verification in Sessions 1-15
structurally could not have caught — read that entry before touching
any `@CurrentTenant()`/`@UseGuards` code, since the fix (folding the
tenant-match check into `JwtAuthGuard`) is now load-bearing for every
authenticated route, not an opt-in you need to remember.

### Phase 4 (Sessions 20-26) — what survived the BUILD-SPEC merge

The Phase-4 feature work below is orthogonal to the C1-C5 corrections and
merged intact. What did NOT survive: the PRD-v2 storage term flow
(fixed N-month terms on one Booking, a WAITLISTED booking queue, and
storefront unit reservation at submission) was reverted, because C4, C5 and
#11 replace it. `RentalOrder` / `WaitlistEntry` are the live model.


- **Session 20** — tenant-facing API keys + outbound webhooks, gated to
  `gudang-aman`.
- **Session 21** — automated KYC verification (provider-port pattern,
  matching Payment/Messaging/Storage/ESign), gated to `sewa-alat`.
- **Session 22** — OTA channel calendar sync via iCal, gated to
  `griya-nginap`.
- **Session 26** — self-serve tenant signup (genuinely public endpoint),
  tenant billing/metering, and a dunning-ladder automation builder. The
  first two are platform-level (gated to one demo `PLATFORM_ADMIN`
  account, `platform-admin@rentos.test`); the automation builder followed
  the earlier sessions' per-tenant pattern (gated to `gudang-aman`).

Sessions 20-22 (and 23-25, doing adjacent engineering-debt work) treated
self-serve signup/billing/the automation builder as business-shaped
decisions the PRD explicitly deferred, and correctly declined to
self-direct into that territory without a business call — see those
sessions' own entries for the reasoning at the time. **Session 26
changed this**: the user explicitly authorized it ("authorized, self
serve, billing and automation builder, implement it only in one user as
a form of demo"), which is exactly the kind of business decision those
earlier sessions were waiting for. With that authorization in hand,
Session 26 made the remaining implementation calls itself (pricing tiers
for billing, which single automation to scope the "visual builder" down
to, the "one user" interpretation as a platform-admin account rather
than per-tenant gating) — see its HANDOFF entry above for the full
reasoning on each. Phase 4, and the PRD's whole named roadmap through
§13, is now fully built.

**Session 23** stepped outside Phase 4 entirely and picked up two
threads of long-standing, purely-technical debt instead: (1) re-tried
Docker build verification (still blocked by org egress policy on
`production.cloudfront.docker.com`, confirmed not a config issue — see
its HANDOFF entry, **don't re-attempt this** until told the policy has
changed) and (2) built the first console UI for a tenant to create/edit
its own catalog (`AssetType` pricing, `Asset` units) — every one before
this session was seed-data-only, flagged as a real gap since Session 1.
Also found and fixed a real bug while doing this: two of `gudang-aman`'s
original three staff accounts had stale password hashes from Session 1
that never matched the documented demo password — every session's
HANDOFF note claiming "password `RentOS!Demo2026` for every one of them"
was quietly wrong for those two specific accounts the whole time. Fixed;
see the entry above for the exact mechanism and how to sanity-check it
doesn't recur on a fresh database.

**Session 24** picked up the `nextInvoiceNumber` race condition from
that same list — fixed, see its HANDOFF entry above.

**Session 25** did the broader sweep Session 24's entry called for:
audited "What's explicitly NOT done" and "Known shortcuts" claim-by-claim
against actual code, found and corrected three stale "NOT done" claims
(automated KYC, unit map, swap requests — all had been done for a while)
plus one smaller drift in "Known shortcuts" (tenant count). No
application code changed. See its HANDOFF entry above for the full
list and methodology.

**With Phase 4 (and the entire named PRD §13 roadmap) now complete**,
future sessions have no remaining named-roadmap item to pick up by
default. Real candidates, none requiring a business decision: no way to
create/edit `Location` rows from the console (same seed-data-only gap
`catalog-setup` closed for `AssetType`/`Asset`, smaller); pooled-
inventory UI affordances (no "N of M beds" display, no manual unit
picker at approval — see "Known shortcuts"); `HOURLY_SLOT`'s FSM/real
math (still a stub, always was lowest-priority/furthest-out per its own
doc comment); productionizing what's currently mock-only (real Xendit/
WhatsApp/Privy/Verihubs credentials, S3 storage, Docker build
verification in an environment with real registry access); or, per
Session 25's own recommendation, another periodic sweep of "Known
shortcuts"/"What's explicitly NOT done" for drift — this file has now
needed that correction twice (Sessions 24 and 25) from claims that went
stale silently for many sessions. Absent further user direction, that
kind of engineering-debt/documentation-integrity work, not new
features, is the reasonable default for a next session to self-direct
into — new named features at this point would mean going beyond the PRD
as originally scoped, itself a decision worth asking about rather than
assuming.

Read Sessions 20-22 and 26's full entries above before touching
`apps/api/src/webhook-dispatch/`, `apps/api/src/api-keys/`,
`apps/api/src/tenant-webhooks/`, `apps/api/src/external-api/`,
`apps/api/src/kyc/`, `apps/api/src/ota-sync/`, `apps/api/src/platform/`,
or `apps/api/src/automation/` — in particular the `ApiKeyGuard` design
rationale (why `TenantApiKey` stays RLS-covered, unlike
`tenants`/`tenant_domains`), the `KycVerificationProvider` per-document
(not matched-pair) simplification, the iCal parser's deliberate
no-recurrence/no-timezone scope, the `app.platform_admin` RLS session
var (Session 26 — the *only* sanctioned way to read a NULL-`tenant_id`
`User` row, see `packages/database/src/platform-context.ts`), the
`daysUntilDue` sign convention in `dunning-ladder.job.ts` (Session 26
flagged this as confusing-but-not-broken, see its entry — don't "fix"
the sign without checking what depends on it first), and the
seed-upsert gotcha, which has now bitten **four** times running: **an
already-seeded DB doesn't retroactively pick up new `featureFlags` keys
from `seed.ts` — only a fresh DB's first seed run does.** Same fix each
time (patch the flag in via SQL, or reset to a fresh database) — stop
being surprised by it. (Session 26 also hit a related-but-distinct
gotcha seeding the platform-admin `User` row itself — see that session's
entry on why `upsert` doesn't work for a NULL-`tenant_id` unique key.)

**Environment note**: mid-Session-22, local Postgres and Redis both
stopped running unprompted and needed `sudo service postgresql start` /
`sudo service redis-server start` before verification could proceed —
check whether the services are actually running before assuming a
`.env`/config problem if a future session hits connection-refused
errors that weren't there moments earlier.

**Phase 3 recap** (Sessions 14-19): NIGHTLY and DURATION_ORDER real
logic, pooled inventory, seasonal pricing, two additional tenants in
different verticals onboarded with **zero application code changes** —
the PRD's core extensibility thesis is validated with real evidence.
Session 16 also closed a real cross-tenant security gap (folded into
`JwtAuthGuard`, now load-bearing for every authenticated route) —
re-verified holding at N=3 tenants in Session 19, and Session 20's new
`ApiKeyGuard` was deliberately designed to not reopen that same bug
class for the new API-key auth path.

**Three tenants are live** (`gudang-aman`/RECURRING_LEASE,
`griya-nginap`/NIGHTLY, `sewa-alat`/DURATION_ORDER). Login credentials
for all three tenants' seeded staff (`admin@gudang-aman.test` /
`ops@griya-nginap.test` / `ops@sewa-alat.test`, plus `finance@<tenant>.test`
for every tenant), password `RentOS!Demo2026` for every one of them.
`gudang-aman` and `griya-nginap` additionally have
`superadmin@<tenant>.test` (same password) — `SUPER_ADMIN` gates the
`/api-access` and `/ota-sync` console pages respectively. `sewa-alat`
has no `SUPER_ADMIN` since Session 21's automated KYC doesn't need one
(`KycController` only requires `OPS_ADMIN`/`FINANCE_ADMIN`).
`gudang-aman` also has `automation_builder_enabled` (Session 26) — its
`superadmin@gudang-aman.test`/`admin@gudang-aman.test` accounts can use
`/automation`.

**One platform-admin account is also live** (Session 26):
`platform-admin@rentos.test`, same demo password, logs in via
`POST /auth/platform/login` (not the per-tenant `/auth/console/login`) —
in the console this is `/platform/login`, a separate route/token from
the tenant-staff `/login` (see `apps/console/src/lib/platform-api.ts`'s
doc comment for why they're deliberately separate clients). This is the
one account that can reach `/platform`, `/platform/billing`, and
`POST /platform/signup`'s effects (that endpoint itself needs no login
at all — it's genuinely public/self-serve).

Low-priority polish left over from Phase 3, worth doing opportunistically
but none of it blocks anything:
1. `HOURLY_SLOT` (venue/studio vertical) is still a typed stub —
   furthest out on the roadmap per its own doc comment, and was never
   on Phase 3's named PRD §13 list to begin with. A fourth tenant on
   this vertical would need its FSM built from scratch first (unlike
   NIGHTLY/DURATION_ORDER, whose FSMs already existed before their real
   math did) — a materially bigger lift than Sessions 14/15/19 were.
2. Console/storefront UI has no pooled-aware affordances yet (no "N of
   M beds available" display distinct from the existing count, no way
   for staff to pick a specific pooled unit at approval time instead of
   accepting the auto-assigned one) — functionally complete without it.
3. No admin UI exists to create/edit `AssetType.pricing` at all
   (seasonal rates included) — every AssetType in this codebase,
   across all three seeded tenants, is seed-data-driven. A real pricing
   management UI is genuinely out of scope for what's been asked so
   far, not an oversight.

DURATION_ORDER's implementation (`packages/domain/src/booking-model/duration-order.strategy.ts`,
`BookingService.pickUp`/`returnEquipment`/`completeInspection` in
`apps/api/src/booking/booking.service.ts`) is the template for anyone
building `HOURLY_SLOT` later — same pattern as NIGHTLY was the template
for DURATION_ORDER: read the target FSM's exact shape in
`packages/domain/src/state-machine/booking-fsm.ts` first (don't assume
it mirrors an existing one), reuse `buildInvoiceDraft` for the
tax/deposit line assembly, and give each genuinely-different lifecycle
step its own service method rather than forcing an existing one to
also handle it.

Before writing new code:
1. `docker compose up` (or run each service manually per README "Local development") in an environment with real network access, to confirm the Dockerfiles actually work — this is unverified debt, still outstanding from Session 1.
2. Re-read "Known shortcuts" below so you don't accidentally treat a deliberate simplification as a bug to "fix" without understanding why it's there.

---

## Architectural decisions log

- **Hand-rolled FSM over xstate** (`packages/domain/src/state-machine/fsm.ts`): the PRD's guard rails (Booking `APPROVED → ACTIVE` requires three conditions checked atomically) need async guards reading live DB state. A plain async-predicate FSM fit that more directly than xstate's actor model, without the dependency weight of features (parallel states, spawned actors, visualizer) this codebase doesn't use.
- **RLS enforcement via a separate `rentos_app` role, not the migrating role** (`packages/database/prisma/migrations/*_enable_rls/migration.sql`): Postgres RLS does not apply to a table's owner by default. `FORCE ROW LEVEL SECURITY` closes that hole for `rentos_app` (no `BYPASSRLS`), while the migrating role gets `BYPASSRLS` explicitly (not assumed via superuser status, which managed Postgres providers often don't grant). Two connection strings: `DATABASE_URL` (migrations/seed only) and `DATABASE_URL_APP` (everything the running services do). Verified live: cross-tenant reads return zero rows, no-tenant-context reads return zero rows (fail-closed), migrator role sees everything.
- **`tenants` and `tenant_domains` are excluded from RLS**, deliberately. Resolving which tenant a request belongs to is the bootstrapping step that happens *before* `app.tenant_id` can be set — a table that needed tenant context to discover the tenant would be a chicken-and-egg lock-out. This is not a leak: which tenant owns which domain is inherently public (it's a live storefront domain).
- **Tenant resolution across services**: `apps/storefront` and `apps/console` are separate Railway services from `apps/api` — the browser calls the API's own domain directly, so the API never sees the tenant's real storefront/console Host. Each Next.js app resolves its own tenant from *its* Host (`apps/storefront/src/lib/tenant.ts`), then forwards it explicitly via `X-Tenant-Slug` on every API call. The API's `TenantMiddleware` honors that header in every environment (not gated to dev) — this is safe because every *authenticated* route requires a JWT, and `JwtAuthGuard` itself rejects any request where the session's `tenantId` disagrees with the header (folded into the guard in Session 16 — see below). The header can only ever influence which tenant's *public* catalog an unauthenticated request browses, which is intentionally public (PRD §7.1.1).
- **The tenant-match check lives inside `JwtAuthGuard`, not a separate opt-in guard** (`apps/api/src/common/guards/jwt-auth.guard.ts`, Session 16): it used to be a standalone `TenantMatchGuard` that each controller had to remember to add alongside `JwtAuthGuard` on every route. It quietly went missing from roughly ten authenticated endpoints (including several *mutating* ones — deposit application/refunds, credit notes, customer blocklisting) — a real cross-tenant data leak, found only once a second tenant with its own staff credentials existed to test against. `JwtAuthGuard.canActivate` now runs the passport JWT check via `super.canActivate()`, then compares `req.user.tenantId` (JWT) against `req.tenant.id` (Host/`X-Tenant-Slug`) and throws `ForbiddenException` on mismatch — every authenticated route gets this automatically, present and future, with nothing to remember. A `PLATFORM_ADMIN` token (`tenantId: null`) still bypasses the check by design, matching the old guard's behavior (that role isn't wired into any controller yet, Phase 4). If you're adding a new authenticated route: `JwtAuthGuard` alone is sufficient, don't look for a separate tenant guard to add — there isn't one anymore, on purpose.
- **`@rentos/database` depends on `@rentos/domain`** (not the reverse), and owns the shared invoice-generation orchestration (`packages/database/src/invoicing.ts`) — not `apps/api`. This is specifically so `apps/worker`'s recurring-invoice and dunning jobs call the *exact* code path `apps/api` uses on booking approval, instead of a second hand-rolled copy that could drift.
- **`apps/worker` is a plain Node/BullMQ process, not a second NestJS app.** It re-implements a small `notify()` helper (`apps/worker/src/notify.ts`) mirroring `apps/api`'s `NotificationsService` rather than sharing NestJS DI across two deployables — the worker has no HTTP surface and pulling in Nest would buy nothing.
- **Console v1 is one Next.js deployment per tenant** (`NEXT_PUBLIC_TENANT_SLUG` baked in at build time), not the PRD's eventual "single console URL with tenant switcher for platform admins" (§6) — that's explicitly Phase 4 platform-admin scope, premature for tenant #1.
- **The ledger is accrual-basis, not cash-basis** (`packages/database/src/ledger.ts`): AR is debited and Revenue/TaxPayable credited at invoice *issue*, not at payment. This is why the schema's `ACCOUNTS_RECEIVABLE` account exists at all — a cash-basis ledger would never need it. Deposits never touch Revenue or AR at any point (they're a liability from the moment cash lands, per PRD §7.2.4). `recordInvoiceIssuedEntries` lives in `packages/database/src/invoicing.ts`'s `persistInvoice`, so both `apps/api` (console-approved invoices) and `apps/worker` (recurring-cycle invoices) get identical ledger treatment automatically — one code path, not two.
- **Ledger writes are paired helper functions, not a generic "post a journal entry" API.** Every call site (`recordInvoiceIssuedEntries`, `recordPaymentReceivedEntries`, `recordDepositHeldEntries`, `recordDepositRefundedEntries`, `recordCreditNoteEntries`) writes both sides of its entry in one function — there is no way to call code that debits without also crediting. This is why the ledger balance-checked cleanly on the first try in live verification; a generic single-entry API would have made an unbalanced write a routine typo away.
- **KYC upload is a proxied multipart POST, not a presigned-URL direct-to-storage flow** — deliberately simpler than the two-step "presign, then PUT to storage, then tell the API the key" dance many production systems use. The original `packages/contracts/src/customer.ts` comment described the presigned-URL approach before this session actually built the upload; that comment was wrong and has been corrected. Bytes transit our own API over TLS once, server-side, and `StorageProvider.save()` handles the rest — correct and simple at this scale. Revisit only if upload volume/size ever makes proxying through the API a real bottleneck.
- **A customer is `VERIFIED` only when every KYC document they've submitted is `VERIFIED`** (`KycService.review`), not just the most recently reviewed one — checked by re-querying all of that customer's `KycDocument` rows after each review and requiring both a KTP and a SELFIE to exist and all be `VERIFIED`. A fresh upload always reopens `PENDING_REVIEW` even if other documents were already verified. Verified live: verifying KTP alone left the customer `PENDING_REVIEW`; verifying the selfie too flipped them to `VERIFIED`.
- **`ApiKeyGuard` (`apps/api/src/external-api/api-key.guard.ts`, Session 20) requires the tenant already resolved by `TenantMiddleware` before it runs** — `TenantApiKey` stays fully RLS-covered (not excluded like `tenants`/`tenant_domains`), and the key lookup always runs via `runInTenantContext(req.tenant.id, ...)`. Deliberately avoids reopening the Session 16 cross-tenant-lookup bug class for a brand-new auth path; see Session 20's HANDOFF entry for the full reasoning.
- **API keys are hashed with SHA-256, not bcrypt** (`apps/api/src/api-keys/api-key.util.ts`): bcrypt's slow-hash design defends against brute-forcing low-entropy human-chosen passwords. An API key is a 24-byte random secret — there's nothing for a slow hash to buy here, and it would add real CPU cost to every external-API request (the hash is recomputed on every call, not just at login).
- **Webhook signing secrets are stored in plaintext, not hashed** (`TenantWebhookSubscription.secret`) — unlike API keys, `apps/worker`'s delivery job needs the actual secret value to compute each delivery's HMAC, so hashing it would make delivery impossible. The console still only shows it once, at creation (same UX convention as Stripe/GitHub webhook secrets), even though it technically could be re-displayed.
- **`WebhookDispatcherService.dispatch()` is a no-op by default, not a guarded call site** — it checks the feature flag and subscription match internally and returns early if either is absent, so `BookingService`/`PaymentsService` call it unconditionally at the point a real event happens rather than wrapping every call site in an `if (tenant.featureFlags.api_access_enabled)` check that would need to be remembered at every future event-emitting call site too.
- **`KycVerificationProvider.verify()` is called once per document, not once per KTP+SELFIE pair** (`apps/api/src/kyc/kyc.service.ts`, Session 21): `KycService.upload()` verifies each document the instant it lands, independent of whether its counterpart has been uploaded yet. This is why `VerihubsKycVerificationProvider` calls Verihubs' single-image OCR/liveness endpoints rather than its face-match-against-KTP endpoint — a true face-match needs both images available together, which would mean either buffering the first upload until the second arrives, or re-verifying both once the pair is complete. Deliberately deferred; `MockKycVerificationProvider` doesn't care either way since it always returns `VERIFIED`.
- **A human review always wins over an automated one** (`KycService.review()`, Session 21): reviewing a document — whether it's sitting in the queue because auto-verification is off, or because an automated check was inconclusive, or even overriding a document the provider already settled — always sets `verificationSource` back to `MANUAL`. There's no path where an automated decision "sticks" against a later staff override.
- **`LocalDiskStorageProvider` is dev/demo-only, not Railway-production-safe as configured** — container filesystems are ephemeral across deploys/restarts unless a persistent Volume is explicitly mounted at `UPLOAD_DIR`. Real KTP/selfie images (actual PII, PRD §10 "encrypted PII at rest") must go through `S3StorageProvider` (`STORAGE_PROVIDER=s3`) before this touches production, or a Volume needs to be attached to the api service on Railway. This is flagged loudly in the provider's own doc comment specifically so it isn't missed.
- **OTA sync is iCal-based, not a paid OTA API integration** (`packages/database/src/ical.ts`, Session 22) — a deliberate choice over building against, say, Airbnb's or Booking.com's actual partner API, which would need a real business relationship/API credentials with a specific OTA before any of it could be exercised even structurally. iCal export/import is how many real self-hosted rental platforms handle this exact problem: no credentials, just an exchange of calendar URLs. The cost is real-time-ness (hourly sync, not a webhook push) and one-way blocking-only semantics (RentOS can't push its own bookings' *rate*, guest details, etc. to the OTA — only which dates are taken).
- **`TenantMiddleware`'s `?tenant=<slug>` query-param fallback** (Session 22) is deliberately checked *after* the `X-Tenant-Slug` header and *before* Host resolution — an explicit header always wins if both are somehow present, and the query param only matters for a caller (like an OTA's calendar fetcher) that can't set custom headers at all. Same public-by-design trust level as the header already had: it can only ever influence which tenant's already-intentionally-public data (catalog, OTA calendar) an unauthenticated request sees.
- **`findAvailableNonPooledAsset`'s OTA-block check is NIGHTLY-only** (`packages/database/src/ota-blocking.ts`, Session 22) — `BookingService.createBooking` only passes a real date window for NIGHTLY bookings; every other booking model passes `null`/`null`, which skips the `OtaBlockedDate` overlap query entirely (a harmless no-op, since no `OtaCalendarSubscription` can even be created for a non-NIGHTLY Asset's booking model in practice — there's no UI path to do so, though the schema doesn't hard-enforce it).
- **A NULL-`tenant_id` row becomes visible under RLS only via a dedicated session var, `app.platform_admin`** (`packages/database/src/platform-context.ts`'s `withPlatformContext`, Session 26) — the `users` table's policy gained one OR-branch: `tenant_id = current_setting('app.tenant_id', true)::uuid OR (tenant_id IS NULL AND current_setting('app.platform_admin', true) = 'true')`. This is the "dedicated platform-admin path" the original `enable_rls` migration's own comment flagged as future work. Deliberately the narrowest possible fix: only `users`' policy changed (not `automation_settings`/`audit_log`/`webhook_events`, the other nullable-`tenant_id` tables the original comment mentions — nothing this session needed touches those), and only `AuthService.platformLogin` ever calls `withPlatformContext`. `JwtAuthGuard` and `RolesGuard` needed zero changes — both already handled a `tenantId: null` JWT correctly since Session 16, for exactly this not-yet-built role.
- **Self-serve signup (`POST /platform/signup`) doesn't ask for a booking-model/vertical** (`apps/api/src/platform/platform.service.ts`, Session 26) — `Tenant` has no field to hold that answer, and inventing one just to store an otherwise-unused value would be exactly the kind of premature field this project's own conventions avoid. A signed-up tenant's admin picks their vertical implicitly, by which `AssetType.bookingModel` they create first via the existing Catalog Setup UI (Session 23) after logging in.
- **Tenant billing is one metered dimension (active asset count), not a multi-metric bill** (`packages/domain/src/billing/plans.ts`, Session 26) — the simplest dimension that's still genuinely usage-based, matching this codebase's repeated preference (hand-rolled FSM, hand-rolled iCal parser, the automation builder's own scope-down below) for the real-but-narrow implementation over a general one nothing here needs yet. See "Known shortcuts" for what this leaves out.
- **Platform billing and a tenant's own ledger are deliberately separate books that never touch** (`PlatformInvoice` vs. `Invoice`/`ledger_entries`, Session 26) — `PlatformInvoice` is RentOS's own AR against the tenant; the existing `ledger_entries` table is a tenant's AR against *its own* customers. Conflating them would mix RentOS's revenue with a tenant's revenue in one table. `generateMonthlyPlatformInvoices` never calls any `ledger.ts` function, and this was verified live: ledger balance summed to exactly 0.00 both before and after a full platform billing run.
- **The "visual automation builder" is scoped down to a structured settings editor for the dunning ladder, not a general condition/action rule canvas** (`packages/contracts/src/automation.ts`, Session 26) — the PRD's own description of the automations catalog (§8.4 A5/A6) is a fixed shape (day offsets, a suspend threshold), not an open-ended workflow language, so this session built the real narrower thing rather than a generic rule engine nothing here needs yet.

## Known shortcuts (intentional, not bugs)

- Every seeded staff user (all three tenants, `packages/database/prisma/seed.ts`) shares one demo password, `RentOS!Demo2026`, hardcoded as a bcrypt hash in the seed file. Fine for local dev/demo; if this seed ever runs against a real deployment, every seeded account needs a real, unique password set immediately — the seed is not a safe way to provision production credentials. (Session 23 found two of `gudang-aman`'s original accounts had drifted from this hash entirely, unrelated to the "one shared password" design — see that session's entry.)
- Pooled inventory (`AssetType.isPooled`, `packages/database/src/pooled-availability.ts`, Session 17) only supports `NIGHTLY` and `DURATION_ORDER` — both always carry an `endDate`, which the date-range overlap check needs. Marking a `RECURRING_LEASE` `AssetType` as pooled throws a plain `Error` ("Pooled inventory is not supported for RECURRING_LEASE bookings") rather than computing something wrong; this surfaces as a 500 via the generic exception filter, not a clean 400, since it's a data-configuration mistake rather than a reachable user flow. `HOURLY_SLOT` isn't wired in either (it's still a typed stub with no bookings to overlap-check in the first place).
- Seasonal pricing (`packages/domain/src/pricing/seasonal.ts`, Session 18) only applies to `NIGHTLY` — `RecurringLeaseStrategy`/`DurationOrderStrategy` never read `PricingConfig.seasonalRates` even if it's present in a snapshot, matching the PRD's own scoping ("needed for hotel vertical"). A `seasonalRates` entry on a non-NIGHTLY `AssetType` is silently inert, not an error — there was no clean way to reject it at the schema level without also blocking legitimate future reuse, and it's a data-configuration mistake, not a reachable user flow.
- **Superseded by Session 23** — a console UI to create/edit `AssetType.pricing` and add `Asset` units now exists (`/catalog-setup`, `apps/api/src/catalog/`). Two real gaps remain from that session's scope: the form doesn't expose `seasonalRates` at all (a tenant wanting peak-season overrides still needs a direct `psql`/API call — the schema and math both already support it, Session 18, just no UI), and there's no console UI to create/edit `Location` rows either (same seed-data-only gap, one level up — `createAsset` requires an existing `locationId`). Neither blocks the base price/deposit/admin-fee/publish workflow Session 23 actually verified end-to-end.
- Auto-assignment of a specific unit from a pool (`BookingService.approve`, when a pooled booking has no `assetId`) always picks the lowest-code eligible unit — there's no way for staff to pick a *specific* pooled unit at approval time short of passing an explicit `assetId` directly via the API (no console UI for it). Fine for interchangeable inventory where the specific unit genuinely doesn't matter (the whole premise of pooling); would need a real picker if a tenant's pooled units ever aren't actually interchangeable in practice (e.g. a bed near a window vs. one by the door).
- Pooled availability's "available now" display number (`CatalogService.availableCount` with no `startDate`/`endDate`) uses a zero-length "right now" window as its default — a reasonable estimate for a walk-in customer, but it's never what actually gates a booking. The real check always runs against the customer's actual requested date range at submission time (`BookingService.createBooking`), so the display number can legitimately be optimistic or pessimistic relative to a specific future date range the customer hasn't picked yet. This is documented behavior, not a bug — no different in spirit from RECURRING_LEASE's pre-existing "point-in-time count, not a range query" shortcut.
- Contract sign-off and invoice payment are two independent async gates that can complete in either order (`BookingService.computeActivationContext`/`finalizeActivation`, `apps/api/src/booking/booking.service.ts`). `handleInvoicePaid` catches `GuardFailedError` and returns quietly when payment lands before the contract is signed (booking stays `APPROVED`); `AgreementsService.sign()` calls `tryActivateAfterContractSigned` after a signature lands, which is a no-op if the invoice isn't paid yet. Whichever gate closes second is the one that actually fires the `ACTIVATE` transition. Verified live for all three cases: `contract_required` flag off, pay-then-sign, and sign-then-pay.
- **Fixed in Session 24** — `nextInvoiceNumber` no longer derives the sequence from a `COUNT(*)` snapshot; it's an atomic `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` against a dedicated `InvoiceNumberCounter` row per tenant/month. Verified race-free with 25 genuinely concurrent calls. See that session's HANDOFF entry.
- The dunning ladder (`apps/worker/src/jobs/dunning-ladder.job.ts`) hardcodes H-7/H-3/H-0/D+1/D+3/D+7/D+14 uniformly across tenants. `AutomationSetting` rows exist in schema for per-tenant override but the worker doesn't read them yet.
- Payment idempotency keys are generated server-side per `initiate()` call, not accepted from the client. True request-level idempotency (retry-safe from the storefront) is a TODO; webhook-level idempotency (the important one, preventing double-processing a gateway retry) IS implemented via the `WebhookEvent` unique `(provider, externalId)` constraint.
- Runtime Docker images copy the *full* installed `node_modules` (including devDependencies) from the build stage rather than doing a second prod-only `pnpm install`. Simpler and more robust for a pnpm workspace with symlinked local packages; costs image size. Revisit once there's a real build environment to validate a leaner runtime install against.
- Credit notes treat the entire credited amount as a Revenue reversal against AR (`recordCreditNoteEntries`), not split proportionally across Revenue/TaxPayable. Correct for crediting a whole remaining balance; approximate for a partial credit on a taxed invoice (the TaxPayable account will be very slightly overstated in that specific case). Exact proportional splitting is a small, contained fix if it ever matters — `FinanceService.createCreditNote` is the one call site.
- Deposit refunds always call `PaymentProvider.refund()` against the *original* payment's `providerRef` (best-effort lookup by booking + DEPOSIT line), never a manual-disbursement-only path. `MockPaymentProvider.refund()` doesn't validate the ref at all, so this was never exercised against a picky real gateway — when wiring real Xendit payouts, double check Xendit's refund API actually accepts a ref from an *invoice* payment for what's conceptually a *deposit* payout (PRD says deposit refunds go out via "Xendit payout," which is a different Xendit product/endpoint than a payment refund — this may need its own adapter method, not reuse of `refund()`).
- Swap-request approval (`SwapRequestsService.approve`) reassigns the asset and re-snapshots pricing immediately and *computes* the mid-cycle proration (`computeSwapProration`, stored on `SwapRequest.prorationNetAdjustment`/`prorationDaysRemaining`), but does **not** auto-generate an invoice or credit note for that number — a downsize computes a negative adjustment, and this codebase's invoice model has no negative-amount convention anything downstream (payments, dunning, the storefront UI) is built to handle. Staff see the exact number in the console swap queue and act on it manually: a credit note for a downsize, a manual charge for an upgrade. A real fix needs a signed-adjustment-line concept on `Invoice`, or a standalone account-credit primitive this schema doesn't have yet — bigger than a "small, contained fix," genuinely deferred, not forgotten.
- `NightlyStrategy.computeFinalSettlement` (`packages/domain/src/booking-model/nightly.strategy.ts`) still throws `BookingModelNotImplementedError` — deliberately. NIGHTLY's FSM (`nightlyBookingFsm`) has no early-checkout or `GIVE_NOTICE`-equivalent transition, only the forward `CHECKED_IN → CHECKED_OUT → CLOSED` path, so this method is genuinely unreachable from any code path today. It becomes real when PRD Appendix B's `EXTENDED`/early-checkout states get built, not before.
- `BookingService.checkIn`/`checkOut` (NIGHTLY) and `pickUp`/`returnEquipment`/`completeInspection` (DURATION_ORDER) each explicitly reject the other booking model (400, not a silent no-op or a confusing FSM error) — the two verticals' lifecycle methods are deliberately not shared, since their FSM shapes diverge (DURATION_ORDER has an extra `INSPECTION` step NIGHTLY doesn't).
- NIGHTLY deposit refunds after checkout, and DURATION_ORDER deposit refunds/damage deductions after inspection, are **not automated** — `checkOut()`/`completeInspection()` only transition the booking/asset; staff process deposit refunds via the existing, unrelated `DepositsService.requestRefund`/`approveRefund`/`applyToDamages` flow (Session 2/12) exactly as they would for a RECURRING_LEASE move-out. This mirrors how RECURRING_LEASE already works (deposit settlement is a separate finance-module concern from the booking FSM), not a gap specific to either newer vertical.
- `DurationOrderStrategy.computeFinalSettlement` (`packages/domain/src/booking-model/duration-order.strategy.ts`) still throws `BookingModelNotImplementedError` — deliberately, same reasoning as `NightlyStrategy`'s: no early-return path exists on `durationOrderBookingFsm` yet (`RETURNED` only goes forward through `INSPECTION` to `CLOSED`).
- DURATION_ORDER's `returnEquipment()` routes the asset through `MAINTENANCE` during the `INSPECTION` window (via `assetFsm`'s existing `SET_MAINTENANCE`/`RETURN_TO_SERVICE` transitions) rather than adding a new asset status — a deliberate reuse of `MAINTENANCE`'s existing meaning ("off-market, not bookable") rather than growing the `AssetStatus` enum for one vertical's inspection step. If a tenant ever needs to distinguish "genuinely broken, needs repair" from "routine post-rental inspection" at the asset-status level, that's a real reason to add a dedicated status — not needed yet.

- The seeded demo webhook subscription (`gudang-aman`, Session 20) points at `https://example.com/webhooks/rentos` — a deliberately non-functional placeholder, not a real endpoint. It exists so the `/api-access` console page has something to show out of the box; every delivery to it fails and retries per BullMQ's backoff, eventually landing `FAILED` once attempts exhaust. This is expected, not a bug — point a subscription at a real receiver to see an actual `SUCCEEDED` delivery.
- Webhook delivery has no manual "retry" or "redeliver" action in the console yet (Stripe/GitHub-style) — once BullMQ's 5 attempts exhaust, a `FAILED` delivery stays `FAILED`; the only way to get the event redelivered today is to trigger the underlying event again (re-approve isn't possible, but e.g. re-paying isn't either since payment is one-shot) or manually re-enqueue via `WebhookDispatcherService` from a script. Small, contained addition if it's ever needed.
- No API key or webhook secret rotation/expiry — keys and secrets are valid until manually revoked/deleted, no TTL, no "rotate and keep the old one valid for N days" grace period.
- `ExternalApiModule`'s two endpoints (`GET /external/bookings`, `GET /external/invoices`) are read-only and unfiltered beyond cursor pagination — no date-range/status query params, no webhook-event-type-specific payload shaping beyond what `WebhookDispatcherService`'s call sites already construct by hand. Sufficient for "connect your own systems" v1; a tenant wanting e.g. "only PAID invoices since date X" needs to filter client-side today.

- **Platform billing overage math is unit-tested but not exercised live at nonzero scale** (`packages/domain/test/billing-plans.test.ts` covers it directly) — every seeded tenant's real asset count (4-10) is under even `TRIAL`'s 10-asset allowance, so the live billing-run verification in Session 26 only exercised the "usage within allowance" path end-to-end through the real DB/HTTP stack. Worth a genuine live check once a tenant's asset count exceeds its plan's allowance for real (or by temporarily lowering a plan's `includedAssets` in `packages/domain/src/billing/plans.ts` for a one-off test).
- **RentOS has no ledger for its own SaaS revenue** (`PlatformInvoice`, Session 26) — `status: PAID` just records that a platform invoice was collected; there's no debit/credit posting anywhere recording *how* (cash, bank transfer, ...) or reconciling it against anything, unlike the rigor `ledger_entries` applies to a tenant's own books. Fine for a metering/billing demo; a real "RentOS's own accounting" story is out of scope, not an oversight.
- **No payment collection is actually wired into platform billing** — `POST /platform/billing/invoices/:id/mark-paid` is a manual "the platform admin says this got paid," not a real charge through `PaymentProvider`/Xendit or any other rail. Matches the "mock adapters now, real keys later" standing pattern, but unlike every other provider-port in this codebase (Payment/Messaging/Storage/ESign/KYC), platform billing collection has no port/adapter at all yet — there's nothing to swap a real implementation into if this becomes real.
- **`daysUntilDue`'s sign convention in `dunning-ladder.job.ts` reads backwards from the "H-7/H-3/H-0" naming's intuitive meaning** (pre-existing since Session 1, not changed by Session 26, discovered while verifying the automation builder's wiring) — `daysBetween(dueDate, today) * -1` yields a *negative* number for a due date N days in the future and a *positive* number for a due date N days in the past. The code is internally consistent (the "before due" reminder loop only ever runs against `ISSUED` invoices, whose due date could legitimately be in the past too, e.g. a day-of-issue invoice with a same-day due date approaching), and this session did not change it or verify whether the sign is actually "wrong" relative to some intended behavior nobody has specified — flagging it here so a future session investigates deliberately (with real due-date scenarios across the "before/after due" boundary) rather than either assuming it's broken or continuing to build on top of an unverified assumption about which direction is correct.
- **Self-serve signup has no rate limiting, CAPTCHA, or email verification** — `POST /platform/signup` is intentionally public per PRD Phase 4's "self-serve," but as built it's also spammable: anyone can create unlimited tenants with unverified admin emails. Acceptable for a demo; a real deployment would need at minimum email verification before a signed-up tenant's admin can do anything destructive, and probably rate limiting/CAPTCHA on the endpoint itself.

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
