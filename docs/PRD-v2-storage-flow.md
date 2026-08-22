# PRD v2 — Self-Storage Booking Flow, Approval Pipeline, Finance Views

| Field | Value |
|---|---|
| Version | 2.0 |
| Owner | Johnson Leonardi |
| Author | Product/Engineering (L9 review lens) |
| Status | Approved for build (decisions confirmed 22 Aug 2026) |
| Scope | `RECURRING_LEASE` (self-storage) tenants. NIGHTLY / DURATION_ORDER tenants are untouched. |
| Depends on | PRD v1 (`docs/PRD.md`), build state in `docs/HANDOFF.md` |

---

## 1. Why

Tenant #1 (self-storage) operates on **monthly terms with a one-month security deposit**, sells by **location first, then unit size**, and closes every deal over **WhatsApp**. The v1 storefront was built around the PRD's generic "pick an AssetType → pick dates" flow with daily/weekly/prorated pricing, which is the wrong shape for this business: customers don't know unit SKUs, they know "the branch near me" and "small / medium / large"; and finance doesn't want prorated fractions, it wants a clean payment schedule it can age forward.

v2 re-shapes the storage flow around how the business actually sells and collects, without touching the pluggable booking-model core that the other two live verticals depend on.

## 2. Decisions (confirmed with owner)

| # | Decision | Consequence |
|---|---|---|
| D1 | Terms are **1 / 3 / 6 / 12 months**, billed as a **monthly payment schedule**. No daily/weekly tiers, no first-month proration. | Invoice #0 (proforma) = month 1 + admin fee + deposit. Invoices #1..N-1 are created `SCHEDULED` at contract time and issued H-7 before each due date. |
| D2 | **Blackout = end date + 1 month** (the deposit-covered month). Blocks **other customers only**; the occupant can extend into it. | Availability is a date-range query over hold windows, not `Asset.status`. `blackout_months` is a tenant setting (default 1). |
| D3 | **Google sign-in (Clerk)**; customers who sign in with Google get **email instead of WhatsApp** for every message (KYC link, contract, proforma, reminders). Phone/OTP customers stay on WhatsApp. | `Customer.preferredChannel` routes every notification. New `EmailProvider` port (console-log default, Resend adapter coded-but-unconfigured). |
| D4 | Map = **Leaflet + OpenStreetMap**, browser geolocation sorts branches by distance. | No API key, no billing. `Location.latitude/longitude` added. |

## 3. Decisions made by the PM (not asked — stated here so they can be overturned)

| # | Decision | Why |
|---|---|---|
| P1 | The staged approval pipeline (**Approval → Request KYC → Generate Contract + Proforma → Finance**) applies to `RECURRING_LEASE` bookings. NIGHTLY/DURATION_ORDER keep "approve = invoice now". | The PRD rule: branch on booking model, never on "is this storage". Hotel/equipment flows have no KYC-then-contract step. |
| P2 | Pipeline stage is **derived**, not a new FSM state per stage. Booking stays `APPROVED` from approval until activation; the stage is computed from `kycRequestedAt`, the customer's `kycStatus`, and whether invoice #0 exists. | Keeps the normative FSM intact; no half-states that need migrations every time the workbench changes. |
| P3 | **Waitlist is a real booking status** (`WAITLISTED`), not a separate table. | Same customer record, same WhatsApp/email trail, same workbench. Staff "Offer unit" when capacity frees up → `PENDING_APPROVAL`. |
| P4 | **Magic links are multi-use for 30 days**, one per (customer, purpose), revocable. Every customer message carries one. | The ask was "no OTP over and over". A single-use link would just move the OTP pain to "link already used". |
| P5 | Scheduled invoices get a **provisional number**; the real tax-sequential number is assigned at issue. | Numbers embed year/month — a November invoice created in August must not carry an August sequence. |
| P6 | **End of term is automated**: a daily worker job moves the lease to `MOVED_OUT` at `endDate` (unit freed, blackout still holds it for 1 month) and expires stale `PENDING_APPROVAL` past their 48h TTL (PRD §8.1 — never actually implemented). Deposit refund stays a manual finance step. | PRD A8; the TTL was documented since Session 1 but nothing enforced it. |
| P7 | Early termination on a term lease **voids the remaining scheduled invoices** instead of computing a prorated final invoice. | "No more proration" applies here too; issued invoices stand. |
| P8 | `Asset.status` becomes the **physical** state (floor view); **bookability** comes from the date-range engine. | A unit occupied until December is still bookable for February. |
| P9 | Contract and proforma are **generated PDFs** (pdfkit), stored through the existing `StorageProvider`, downloadable from portal and console. The signed upload flow is unchanged. | "Generate contract" has to produce a document, not a database row. |

## 4. Storefront

### 4.1 Flow (RECURRING_LEASE tenants)

```
/                       Choose a branch   — Leaflet map + list, sorted by distance (geolocation, optional)
/locations/:id          Choose a size     — SMALL / MEDIUM / LARGE cards (AssetType.attributesSchema.sizeClass), price/month, "N available"
/locations/:id/:typeId  Your details      — check-in date · term (1/3/6/12) · full name · WhatsApp → live availability + price preview
                        Result            — "Request received, confirmation soon" (→ approval pipeline)
                                          — "You're on the waitlist (#n)"          (→ WAITLISTED)
/m/:token               Magic link landing — exchanges token for a session, redirects to ?next=
/login                  Phone OTP (existing) + "Continue with Google" (Clerk, shown only when NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is set)
/portal                 Payment schedule per rental, KYC, contract, proforma/invoice PDFs
```

Tenants whose catalog has no `RECURRING_LEASE` AssetType keep the v1 catalog → asset-type → booking-form flow untouched.

### 4.2 Price preview

`GET /catalog/asset-types/:id/quote?startDate&termMonths` reuses `RecurringLeaseStrategy.computeInitialInvoice` (proforma: month 1 + admin fee + deposit + PPN) and returns the full schedule preview (N rows). Same math as the real invoice — the preview cannot drift.

### 4.3 Availability

`GET /catalog/availability?locationId&assetTypeId&startDate&termMonths` → `{ available, availableCount, waitlistAhead }`.

Unit **U** is available for window **[S, E)** (E = S + term) iff U is not `MAINTENANCE`/`RETIRED` and no committed booking **B** on U satisfies
`B.start < E + blackout  AND  B.end + blackout > S` (both hold windows overlap),
except when B belongs to the same customer and the new booking is an extension of B.
Committed = `PENDING_APPROVAL, NEEDS_INFO, APPROVED, ACTIVE, RENEWING, SUSPENDED, NOTICE_GIVEN, DEFAULT`. `WAITLISTED` and terminal states never hold a unit.

### 4.4 Submission rules

- Full is never a dead end: no capacity → booking is created `WAITLISTED` (no unit held), customer is told their position.
- Capacity → `PENDING_APPROVAL`, lowest-code eligible unit soft-reserved (`reservedUntil` = +48h, enforced by the worker).
- A logged-in customer (OTP or Google) is attached by session; an anonymous one is found/created by WhatsApp number. Google customers are keyed by email and get `preferredChannel = EMAIL`.
- Blocklisted customers are rejected as today.

### 4.5 Messages (channel = customer's preferred channel; every one carries a magic link)

| Event | Template | Link target |
|---|---|---|
| Submitted, capacity | `booking_received` | `/portal/bookings/:id` |
| Submitted, no capacity | `booking_waitlisted` (position) | `/portal/bookings/:id` |
| Offered a unit from waitlist | `waitlist_unit_offered` | `/portal/bookings/:id` |
| Approved | `booking_approved` ("next: verify your identity") | `/portal/kyc` |
| KYC requested | `kyc_requested` | `/portal/kyc` |
| Contract + proforma ready | `contract_proforma_ready` (amount, due) | `/portal/invoices/:id` |
| Scheduled invoice issued | `invoice_issued` | `/portal/invoices/:id` |
| Reminders / overdue / suspended | existing dunning templates | `/portal/invoices/:id` |
| Term ended | `term_ended` | `/portal/bookings/:id` |
| Rejected / expired | `booking_rejected` / `booking_expired` | — |

## 5. Console

### 5.1 Approval pipeline (`/bookings`)

Five columns, each card shows the one action that moves it forward:

| Column | Who's in it | Primary action |
|---|---|---|
| Waitlist | `WAITLISTED`, oldest first | **Offer unit** (re-checks availability; → `PENDING_APPROVAL`, notifies) · Close |
| Awaiting approval | `PENDING_APPROVAL` / `NEEDS_INFO` | **Approve** (→ `APPROVED`, no invoice yet) · Reject |
| KYC | `APPROVED`, tenant requires KYC, customer not `VERIFIED` | **Request KYC** (sends magic link; re-sendable) · review link when docs are pending |
| Contract & proforma | `APPROVED`, KYC satisfied, no invoice #0 | **Generate contract + proforma** (contract PDF + full payment schedule, sends pay link) |
| Finance | `APPROVED`, invoice #0 unpaid | link to invoice (record/verify payment, maker-checker as today) — activation on payment is unchanged |

Stage is returned by `GET /bookings/pipeline` as `pipelineStage`; the FSM is not forked (P2).

### 5.2 Finance / Reports

- **AR aging with horizon**: `GET /reports/ar-aging?asOf=YYYY-MM-DD&horizonDays=30|60|90`. Returns overdue buckets as of that date (current / 1–30 / 31–60 / 60+) **and** "coming due" buckets inside the horizon (0–30 / 31–60 / 61–90 days) from `ISSUED` + `SCHEDULED` invoices, with totals. Console: as-of date picker + horizon chips.
- **Client list** (directly below the Export buttons, also at `/clients`): search (name / phone / email / unit code), status filter, columns: customer · unit(s) & branch · move-in · status · next due · outstanding. Click → `/clients/:id` (profile, KYC, rentals with schedule, invoices, payments, deposits, message log).

Status rules (`classifyCustomerHealth`, pure function, unit-tested):

| Status | Rule |
|---|---|
| **Overdue** | any `OVERDUE` invoice, or `ISSUED` past due |
| **Risky** | next unpaid invoice due within 7 days |
| **Healthy** | active rental, nothing due within 7 days (incl. paid ahead) |
| **Inactive** | no active/approved/pending rental |

### 5.3 Catalog setup

- Daily/weekly rate fields removed; `sizeClass` (SMALL/MEDIUM/LARGE) added to AssetType.
- Locations: create/edit name, address, latitude, longitude (gap flagged since Session 1 — needed now for the map).

## 6. Data model (migration `20260822_v2_storage_flow`)

| Change | Detail |
|---|---|
| `BookingStatus` | + `WAITLISTED` |
| `CustomerChannel` | new enum `WHATSAPP`, `EMAIL` |
| `Location` | + `latitude`, `longitude` (nullable) |
| `Customer` | `phone` nullable; + `preferredChannel` (default WHATSAPP), `clerkUserId`; unique `(tenantId, email)`, `(tenantId, clerkUserId)` |
| `Booking` | + `termMonths`, `locationId`, `extendsBookingId`, `kycRequestedAt`, `contractGeneratedAt`, `waitlistedAt` |
| `Invoice` | + `scheduleIndex` (0 = proforma), `documentUrl` (PDF key) |
| `Contract` | + `unsignedDocumentUrl` (generated PDF key; `documentUrl` stays the signed upload) |
| `CustomerAccessToken` | new, RLS-covered: `tokenHash` (unique), `customerId`, `purpose`, `expiresAt`, `useCount`, `lastUsedAt`, `revokedAt` |
| Tenant settings (in `featureFlags` JSON) | `blackout_months` (1), `invoice_lead_days` (7), `kyc_required` (existing) |

Every new table repeats ENABLE / FORCE / `tenant_isolation` policy, as every migration since `enable_rls` does.

## 7. State machine changes (RECURRING_LEASE only)

```
DRAFT ──SUBMIT (capacity)──▶ PENDING_APPROVAL            (unchanged)
DRAFT ──WAITLIST (no capacity)──▶ WAITLISTED             (new)
WAITLISTED ──OFFER_UNIT──▶ PENDING_APPROVAL              (new, staff)
WAITLISTED ──EXPIRE / REJECT──▶ EXPIRED / REJECTED        (new)
PENDING_APPROVAL ──EXPIRE──▶ EXPIRED                      (existing, now actually fired by the worker at reservedUntil)
ACTIVE | RENEWING ──TERM_ENDED──▶ MOVED_OUT               (new, worker at endDate)
```
Everything else — the triple-AND `APPROVED → ACTIVE` guard, RENEWING/SUSPENDED, notice flow — is unchanged.

## 8. Invoice lifecycle for a term

```
contract generated:  #0 ISSUED (number, ledger, due = min(start, +7d))   #1..N-1 SCHEDULED (provisional number, no ledger)
daily worker:        SCHEDULED with issueDate <= today  ──ISSUE──▶ ISSUED (real number, ledger AR/Revenue/Tax, customer notified, lease ACTIVE → RENEWING)
payment:             ISSUED/OVERDUE ──▶ PAID (unchanged; RENEWING → ACTIVE)
dunning:             unchanged (reads ISSUED/OVERDUE only)
early termination:   remaining SCHEDULED ──CANCEL──▶ VOID
```

## 9. Auth

- **Magic link**: `POST /auth/magic/exchange { token }` → customer JWT (12h). Tokens are SHA-256 hashed at rest, 30-day expiry, multi-use, revocable, tenant-scoped under RLS. URL = `{storefront base}/m/{token}?next={path}`; base = tenant's primary domain, else `STOREFRONT_BASE_URL`.
- **Google via Clerk**: storefront wraps in `ClerkProvider` only when `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` exists; after sign-in, `POST /auth/clerk/exchange { token }` verifies the Clerk session JWT (`@clerk/backend`, `CLERK_SECRET_KEY`), finds/creates the customer by email (`preferredChannel = EMAIL`), returns our JWT. No Clerk middleware — purely additive.

## 10. Out of scope / pending (explicitly)

- WhatsApp Business API credentials + per-tenant setup screen in console (pending — adapter exists, `MESSAGING_PROVIDER=whatsapp_cloud`).
- Xendit live keys (pending — adapter exists).
- Real email delivery (Resend adapter is coded; needs `RESEND_API_KEY`).
- Term extension from the portal (designed — `extendsBookingId` is in the schema and the blackout exemption is implemented — UI is the follow-up).
- Automatic waitlist promotion when a unit frees up (staff-driven for now; the engine already knows).

## 11. Acceptance (what "done" means for this build)

1. Storefront: branch map → size → details → submitted or waitlisted; availability respects terms and the blackout month; DAILY/WEEKLY no longer offered.
2. Magic link from a message logs the customer in without OTP; Google sign-in works when Clerk keys are present and is invisible when they're not.
3. Console pipeline walks a booking Approval → KYC → Contract + proforma → Finance → ACTIVE, with the right message at each step on the customer's preferred channel.
4. Generated contract + proforma PDFs are downloadable; the payment schedule has N rows; the worker issues scheduled invoices and ends terms.
5. AR aging supports as-of + 30/60/90 horizons; client list with search/filter/status and a detail drill-down.
6. `turbo run typecheck test build` is green; ledger balances after the full flow; NIGHTLY/DURATION_ORDER tenants' flows still pass their existing verification.
