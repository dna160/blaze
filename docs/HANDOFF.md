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
| **3 — Multi-vertical proof** | NIGHTLY + DURATION_ORDER real logic, pooled inventory, seasonal pricing, second tenant | ✅ **Every named item on PRD §13's Phase 3 list is done.** NIGHTLY (Session 14) and DURATION_ORDER (Session 15) are both real end-to-end. A second tenant in the NIGHTLY vertical is live (Session 16) — the extensibility thesis is validated with zero application code changes, and that exercise also found and fixed a real cross-tenant data leak. Pooled inventory (Session 17) drives genuine date-range-overlap capacity checking. **Seasonal/dynamic pricing (Session 18)** closes the list — real per-night rate overrides with a live demo. `HOURLY_SLOT` (venue/studio) is the one booking model still a stub, but it was never on Phase 3's named list — it's explicitly Phase-3-and-beyond, lowest priority, PRD's own "furthest out on the roadmap." |
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

### What's explicitly NOT done (don't assume it exists)

- Per-tenant `AutomationSetting` rows are schema-only — `apps/worker`'s dunning ladder hardcodes the H-7/H-3/H-0/D+1/D+3/D+7/D+14 steps uniformly, doesn't read tenant config
- Invoice-payment refunds (as opposed to deposit refunds) — no endpoint; `PaymentProvider.refund()` is only called from the deposit-refund flow today
- Automated KYC verification (Verihubs or similar) — PRD explicitly scopes this to P2; v1 review is 100% manual, by design.
- Unit map (visual grid) — list view only (P1 in PRD anyway)
- Swap/upgrade requests, promo codes, duration discounts — schema exists, zero application logic
- Platform admin console (multi-tenant switcher, tenant provisioning wizard) — out of scope until Phase 4; today, provisioning a tenant means writing rows directly (see `packages/database/prisma/seed.ts` as the template)
- Real Xendit/WhatsApp Cloud credentials — adapters are coded against the real APIs but unconfigured; `PAYMENT_PROVIDER=mock` / `MESSAGING_PROVIDER=console_log` is what actually runs today
- **Docker builds were never actually executed in this sandbox** — Docker Hub registry access is blocked by this environment's egress policy (confirmed via repeated 403s on `production.cloudfront.docker.com`, same class of block as `backboard.railway.com`). The Dockerfiles follow standard, well-established patterns (Turborepo `prune --docker`, Next.js `output: standalone`) and `turbo prune` itself was verified working locally, but nobody has run `docker build` or `docker compose up` against them. **Validate this first** in any environment with real registry access before trusting it blindly.

---

## Resume here

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

**Next up is Phase 4** per PRD §13 — explicitly marked "(optional)" in
the PRD, gated on a monetization decision the owner deliberately
deferred ("Phases 0–3 are architected so that gate is a pricing
decision, not a rebuild"). Its scope: self-serve tenant signup,
tenant billing/metering, a visual automation builder, OTA channel sync
(hotel), tenant-facing API/webhooks, and KYC automation. **Do not
start Phase 4 without explicit direction** — it's the one phase the
PRD itself frames as a business decision, not a default next sprint,
unlike Phases 1-3 which were unconditionally "build these."

Low-priority polish left over from Phase 3, worth doing opportunistically
but none of it blocks anything:
1. `HOURLY_SLOT` (venue/studio vertical) is still a typed stub —
   furthest out on the roadmap per its own doc comment, and was never
   on Phase 3's named PRD §13 list to begin with.
2. A DURATION_ORDER or third-vertical tenant, if there's ever a
   concrete reason to onboard one — the extensibility thesis is already
   validated with two tenants across two non-RECURRING_LEASE verticals.
   Not required.
3. Console/storefront UI has no pooled-aware affordances yet (no "N of
   M beds available" display distinct from the existing count, no way
   for staff to pick a specific pooled unit at approval time instead of
   accepting the auto-assigned one) — functionally complete without it.
4. No admin UI exists to create/edit `AssetType.pricing` at all
   (seasonal rates included) — every AssetType in this codebase is
   seed-data-driven, including the two seeded tenants. A real pricing
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
- **`LocalDiskStorageProvider` is dev/demo-only, not Railway-production-safe as configured** — container filesystems are ephemeral across deploys/restarts unless a persistent Volume is explicitly mounted at `UPLOAD_DIR`. Real KTP/selfie images (actual PII, PRD §10 "encrypted PII at rest") must go through `S3StorageProvider` (`STORAGE_PROVIDER=s3`) before this touches production, or a Volume needs to be attached to the api service on Railway. This is flagged loudly in the provider's own doc comment specifically so it isn't missed.

## Known shortcuts (intentional, not bugs)

- Every seeded staff user (both tenants, `packages/database/prisma/seed.ts`) shares one demo password, `RentOS!Demo2026`, hardcoded as a bcrypt hash in the seed file. Fine for local dev/demo; if this seed ever runs against a real deployment, every seeded account needs a real, unique password set immediately — the seed is not a safe way to provision production credentials.
- Pooled inventory (`AssetType.isPooled`, `packages/database/src/pooled-availability.ts`, Session 17) only supports `NIGHTLY` and `DURATION_ORDER` — both always carry an `endDate`, which the date-range overlap check needs. Marking a `RECURRING_LEASE` `AssetType` as pooled throws a plain `Error` ("Pooled inventory is not supported for RECURRING_LEASE bookings") rather than computing something wrong; this surfaces as a 500 via the generic exception filter, not a clean 400, since it's a data-configuration mistake rather than a reachable user flow. `HOURLY_SLOT` isn't wired in either (it's still a typed stub with no bookings to overlap-check in the first place).
- Seasonal pricing (`packages/domain/src/pricing/seasonal.ts`, Session 18) only applies to `NIGHTLY` — `RecurringLeaseStrategy`/`DurationOrderStrategy` never read `PricingConfig.seasonalRates` even if it's present in a snapshot, matching the PRD's own scoping ("needed for hotel vertical"). A `seasonalRates` entry on a non-NIGHTLY `AssetType` is silently inert, not an error — there was no clean way to reject it at the schema level without also blocking legitimate future reuse, and it's a data-configuration mistake, not a reachable user flow.
- There is no admin/console UI anywhere to create or edit `AssetType.pricing` (base price, deposit rule, admin fee, seasonal rates, or anything else in that JSON blob) — every `AssetType` in this codebase, across both seeded tenants, is created via `packages/database/prisma/seed.ts` or a direct `psql` edit. This has been true since Session 1 and isn't specific to seasonal pricing; noted here because Session 18 is the first feature where a tenant might plausibly want to self-serve-edit pricing on some regular cadence (adding next year's peak season), and there's genuinely no way to do that today short of editing seed data or the database directly.
- Auto-assignment of a specific unit from a pool (`BookingService.approve`, when a pooled booking has no `assetId`) always picks the lowest-code eligible unit — there's no way for staff to pick a *specific* pooled unit at approval time short of passing an explicit `assetId` directly via the API (no console UI for it). Fine for interchangeable inventory where the specific unit genuinely doesn't matter (the whole premise of pooling); would need a real picker if a tenant's pooled units ever aren't actually interchangeable in practice (e.g. a bed near a window vs. one by the door).
- Pooled availability's "available now" display number (`CatalogService.availableCount` with no `startDate`/`endDate`) uses a zero-length "right now" window as its default — a reasonable estimate for a walk-in customer, but it's never what actually gates a booking. The real check always runs against the customer's actual requested date range at submission time (`BookingService.createBooking`), so the display number can legitimately be optimistic or pessimistic relative to a specific future date range the customer hasn't picked yet. This is documented behavior, not a bug — no different in spirit from RECURRING_LEASE's pre-existing "point-in-time count, not a range query" shortcut.
- Contract sign-off and invoice payment are two independent async gates that can complete in either order (`BookingService.computeActivationContext`/`finalizeActivation`, `apps/api/src/booking/booking.service.ts`). `handleInvoicePaid` catches `GuardFailedError` and returns quietly when payment lands before the contract is signed (booking stays `APPROVED`); `AgreementsService.sign()` calls `tryActivateAfterContractSigned` after a signature lands, which is a no-op if the invoice isn't paid yet. Whichever gate closes second is the one that actually fires the `ACTIVATE` transition. Verified live for all three cases: `contract_required` flag off, pay-then-sign, and sign-then-pay.
- `nextInvoiceNumber` (`packages/database/src/invoice-number.ts`) derives the sequence from a per-tenant monthly `COUNT(*)` inside the same transaction as invoice creation. Correct at demo scale; races under concurrent invoice creation for the same tenant. A dedicated Postgres sequence per tenant is the real fix (Phase 2).
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
