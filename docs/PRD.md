# PRD — RentOS (Codename)
## Multi-Tenant Rental Operations Platform
| Field | Value |
|---|---|
| Version | 1.0 (Draft for review) |
| Owner | Johnson Leonardi |
| Author | Product/Engineering (L9 review lens) |
| Status | Draft |
| Date | 16 July 2026 |
| Launch market | Indonesia-first (IDR, Xendit/Midtrans, WhatsApp) |
| First tenant | Self-storage rental company |
| Monetization | Internal tool first; architecture must not preclude future SaaS |
---
## 1. Executive Summary
RentOS is a multi-tenant platform for asset rental businesses. It ships with two surfaces:
1. **Storefront (customer-facing):** browse inventory, check availability, request/book a rental, complete KYC, pay via Indonesian payment rails, and self-manage the rental lifecycle (renew, upgrade, terminate) through a customer portal.
2. **Console (internal admin):** approve booking requests, manage inventory and pricing, run the full finance lifecycle (invoicing, reconciliation, deposits, dunning, refunds, reporting), and configure automations.
The first tenant is a self-storage operator. The architecture generalizes to any **"asset × time" rental business** — storage, hotel/kost, equipment (Booqable-style), venue, vehicle — by making the **booking model pluggable** rather than hardcoding storage logic. This is the single most important design decision in this document (§5).
**What we are NOT building in v1:** channel management (OTA sync), housekeeping ops, POS, dynamic revenue management, marketplace/discovery across tenants. These are roadmap items (§15).
---
## 2. Problem & Opportunity
### 2.1 Problem (first tenant: storage operator)
- Bookings arrive via WhatsApp/phone; availability lives in a spreadsheet. Double-booking and stale unit status are routine.
- Recurring monthly billing is manual: invoices sent by hand, payments matched by eyeballing bank mutations, overdue follow-up is inconsistent → revenue leakage and AR aging blowout.
- No approval discipline: anyone can promise a unit; finance finds out later.
- No customer self-service: every renewal, termination, or upgrade is a chat thread.
- Zero reporting: occupancy, revenue per available unit, churn — unknown.
### 2.2 Opportunity
- Booqable, Odoo Rental, and storage-specific tools (Storeganise, Stora) prove the category but are (a) priced in USD, (b) weak on Indonesian rails (VA/QRIS/e-wallet, WhatsApp-first comms), and (c) either vertical-locked or over-generalized.
- Building tenant-aware from day one converts an internal tool into a licensable asset later at near-zero marginal architecture cost — consistent with the owner's asset-building thesis.
### 2.3 Non-goals for this PRD
- Pricing/packaging of RentOS as SaaS (deferred; internal tool first).
- Native mobile apps (responsive web only in v1).
---
## 3. Vision & Product Principles
**Vision:** One platform where any rental operator can list assets, take bookings, get paid, and run finance — configured, not customized.
**Principles (tie-breakers for every design dispute):**
1. **Configuration over code.** A new vertical (hotel, equipment) must be onboarded by changing tenant config, not forking the codebase.
2. **The state machine is the product.** Every booking, invoice, and unit has an explicit lifecycle. No status lives in someone's head or a WhatsApp thread.
3. **Finance is first-class, not a report.** Every operational event (approve, check-in, terminate) emits a financial consequence automatically.
4. **WhatsApp is the primary channel** in this market. Email is the archive, not the interface.
5. **Approval is a workflow, not a checkbox.** Requests route to the right role with SLA timers and escalation.
6. **Multi-tenant from commit #1.** Every table carries `tenant_id`; every query is tenant-scoped by default (enforced, not by convention).
---
## 4. Personas
| Persona | Surface | Jobs-to-be-Done |
|---|---|---|
| **Renter (end customer)** | Storefront | "Find a unit that fits my stuff, know the price instantly, book and pay without calling anyone, and never miss a payment deadline." |
| **Ops Admin** | Console | "See every request in one queue, approve/reject with full context, keep the unit map accurate." |
| **Finance Admin** | Console | "Invoices go out on time, payments reconcile themselves, I chase only real exceptions, and month-end closes in hours not days." |
| **Owner / Super Admin** | Console | "Occupancy, revenue, AR at a glance. Control who can do what. Onboard a second business without a second system." |
| **Platform Admin (us)** | Platform console | "Provision tenants, manage feature flags, monitor health." |
RBAC matrix in Appendix C.
---
## 5. Core Domain Model — The Extensibility Thesis
The generalization from "storage" to "any rental/hotel business" lives in four abstractions:
### 5.1 Asset & AssetType
- **AssetType** = a rentable SKU category defined per tenant: "Storage Unit 3×3m", "Deluxe Room", "Sony A7IV Kit". Carries attributes schema (size, floor, climate control / bed count, view / serial number), photos, pricing rules, and a **booking model** (below).
- **Asset** = a physical instance of an AssetType: Unit B-14, Room 302, Camera #7. Has its own lifecycle: `AVAILABLE → RESERVED → OCCUPIED → MAINTENANCE → RETIRED`.
- Storage and hotel are **serialized inventory** (each asset is unique and bookable individually). Equipment rental is often **pooled inventory** (quantity of interchangeable items). v1 ships serialized; pooled is a Phase 3 flag on AssetType.
### 5.2 BookingModel (the pluggable core)
Every AssetType declares exactly one booking model. The model dictates calendar math, billing cadence, and lifecycle verbs:
| BookingModel | Time unit | Billing | Lifecycle verbs | Vertical |
|---|---|---|---|---|
| `RECURRING_LEASE` | Month (anchor date) | Recurring invoice, auto-renew until terminated, prorate on entry/exit | move-in, renew, terminate, notice period | **Storage (v1)**, kost, parking |
| `NIGHTLY` | Night (check-in/out dates) | One invoice per stay, paid upfront or at checkout | check-in, check-out, extend | Hotel, villa |
| `DURATION_ORDER` | Day/week range | One invoice per order + security deposit hold | pickup, return, inspect, deposit release | Equipment (Booqable-style) |
| `HOURLY_SLOT` | Hour slots | Per-slot invoice | start, end | Venue, studio (Phase 3) |
**Rule:** No feature may branch on "is this storage?" — only on booking model and tenant config. This rule is enforced in code review.
### 5.3 Booking, Contract, and the Financial Spine
- **Booking** = customer × asset(s) × time window × price snapshot. Owns the approval state machine (§8.1).
- **Contract/Agreement** = generated document (rental terms, e-signed) attached to an approved booking. Template per tenant per AssetType.
- **Invoice → Payment → LedgerEntry:** every booking event generates invoices per its booking model; payments (gateway or manual) match against invoices; everything lands in an append-only ledger for audit and accounting export.
### 5.4 Tenant, Location, User
- **Tenant** = one business (our storage client = tenant #1). Owns branding, domain, payment gateway credentials, tax config, templates, automation rules, and users.
- **Location** = physical site under a tenant (a storage facility, a hotel property). Assets belong to locations. Multi-location is v1 scope (cheap now, expensive later).
- **User** = belongs to a tenant with role(s); customers are tenant-scoped identities (same phone number can be a customer of two tenants independently).
Entity-relationship sketch in Appendix A.
---
## 6. Multi-Tenancy Architecture
| Decision | Choice | Rationale |
|---|---|---|
| Isolation model | Shared database, shared schema, `tenant_id` on every row + Postgres Row-Level Security | Cheapest to operate at 1–100 tenants; RLS makes cross-tenant leakage a DB-enforced impossibility, not an app-level convention. Revisit schema-per-tenant only if an enterprise client demands it. |
| Tenant resolution | Subdomain (`{tenant}.rentos.app`) + custom domain (CNAME) for storefront; single console URL with tenant switcher for platform admins | Standard, cache-friendly, custom domain preserves tenant brand. |
| Theming | Per-tenant: logo, palette (primary/accent), typography choice from a curated set, hero content, footer/legal. No per-tenant code. | Config over code (Principle 1). |
| Feature flags | Per-tenant flags (e.g., `deposits_enabled`, `kyc_required`, `auto_approve`) | One codebase, many behaviors. |
| Data residency | Single region (Jakarta) v1 | Indonesian client base; PDP Law compliance simpler. |
| Tenant provisioning | Platform console wizard: create tenant → seed roles → connect payment gateway → import assets (CSV) → publish storefront | Target: new tenant live in < 1 day without engineering. |
**Hard requirements:**
- Every API request carries tenant context derived from the authenticated session/domain — never from client-supplied parameters.
- Background jobs, exports, and webhooks are tenant-scoped.
- Per-tenant encryption of gateway credentials and PII columns (KTP numbers).
---
## 7. Feature Requirements
Priority key: **P0** = v1 launch blocker · **P1** = fast-follow (≤ 90 days) · **P2** = roadmap.
### 7.1 Storefront (Customer Front End)
#### 7.1.1 Catalog & Availability — P0
- Public catalog of AssetTypes per location: photos, attributes, price ("from Rp X/month"), real-time availability count.
- Availability engine answers: "which units of type T are free for window W?" — single source of truth shared with Console; a unit reserved in Console disappears from Storefront within seconds.
- Size guide / comparison for storage (what fits in 1.5×2 vs 3×3); generalizes to room comparison for hotel tenants.
- SEO-rendered pages (this is the tenant's marketing site surface, not just an app).
#### 7.1.2 Booking Flow — P0
1. Select AssetType → location → start date (RECURRING_LEASE) or date range (other models).
2. Price preview: first invoice breakdown — prorated first month (tenant-configurable: anchor-date proration vs full first month), deposit, admin fee, PPN 11% if tenant is PKP.
3. Account creation via **phone number + WhatsApp OTP** (primary) or email. No passwords in v1 for customers; OTP-only.
4. **KYC (tenant-configurable):** upload KTP + selfie; stored encrypted; verification manual by admin in v1 (P0), automated via Verihubs/similar (P2).
5. Submit → booking enters `PENDING_APPROVAL` (or `APPROVED` instantly if tenant enables auto-approve for that AssetType).
6. Clear post-submit expectation setting: "You'll get a WhatsApp confirmation within X hours" (X = tenant SLA config).
#### 7.1.3 Checkout & Payments — P0
- **Gateway: Xendit primary** (broadest VA + QRIS + e-wallet coverage, strong recurring API); Midtrans behind the same internal `PaymentProvider` interface as fallback/tenant choice. All gateway code isolated behind this interface — adding Stripe later touches one module.
- Methods v1: Virtual Account (BCA/Mandiri/BNI/BRI), QRIS, e-wallets (OVO/GoPay/DANA/ShopeePay), credit/debit card.
- **Recurring for RECURRING_LEASE:** default = invoice + payment link each cycle (works with VA/QRIS habits); optional card/e-wallet autodebit where supported — P1.
- Payment page hosted by us, gateway-tokenized; we never store card PANs (SAQ-A scope).
- Webhook-driven payment confirmation → booking/invoice state transitions automatic (§8.2). Manual "I have paid" claims never change state; only webhooks or admin manual-payment entry do.
#### 7.1.4 Customer Portal — P0
- My rentals: active/past bookings, contract PDF, unit details, access instructions.
- Invoices & receipts: list, status, pay-now deep link.
- Self-service actions: **renew** (extend/confirm next cycle), **give termination notice** (enforces tenant's notice period, computes final invoice/prorate), **request upgrade/downsize** (creates a swap request routed to admin) — P0 for renew/terminate, P1 for swap.
- Profile & KYC documents.
#### 7.1.5 Notifications — P0
- **WhatsApp (via BSP: Qontak/Wati/Meta Cloud API) as primary channel**, email as fallback/archive. Template messages per event, per tenant, bilingual (ID/EN).
- v1 events: booking received, approved/rejected, payment link, payment confirmed, invoice issued (H-7, H-3, H-0), overdue (D+1, D+3, D+7), termination confirmed, deposit refunded.
### 7.2 Console (Internal Admin Back End)
#### 7.2.1 Approval Workbench — P0
- Single queue of `PENDING_APPROVAL` bookings with full context: customer profile + KYC docs, requested asset, price snapshot, history/notes.
- Actions: approve (assign specific unit if not auto-assigned), reject (reason codes + templated WhatsApp reply), request more info (moves to `NEEDS_INFO`, notifies customer).
- SLA timer per request; breach escalates (notify owner) — timer P0, escalation P1.
- Approval policy per tenant/AssetType: manual-all, auto-approve-if-KYC-verified, auto-approve-all.
#### 7.2.2 Inventory & Asset Management — P0
- Asset registry per location: bulk import (CSV), attributes, photos, status.
- **Visual unit map** (grid/floor layout) with status colors — P1 (list view is P0).
- Status transitions with reasons (maintenance notes); blocking an asset auto-removes it from availability.
- Occupancy view: who's in which unit, since when, paid-through date.
#### 7.2.3 Pricing Engine — P0 core / P1 advanced
- P0: base price per AssetType per billing period; deposit amount/rule; admin/one-time fees; proration rule; tax flag (PPN-inclusive vs exclusive); promo codes (flat/%; first-cycle vs recurring).
- P1: duration discounts (pay 12 months get 1 free), per-unit price overrides, scheduled price changes with grandfathering for existing leases.
- P2: seasonal/dynamic pricing (needed for hotel vertical).
#### 7.2.4 Finance Module — P0 (this is half the product)
- **Invoicing:** auto-generation per booking model (recurring on anchor date for leases; on approval for orders/stays). Sequential, tenant-prefixed invoice numbers (tax-compliant), PDF, PPN line handling, credit notes for adjustments.
- **Payments & reconciliation:** gateway webhooks auto-match to invoices; manual payment entry (cash/transfer) with proof upload and maker-checker (recorder ≠ verifier) — verification step P1; partial payments and overpayment-as-credit P1.
- **Deposits:** held as liability (not revenue), applied against damages/final invoice, refund workflow with approval + disbursement via Xendit payout — P0 for storage deposits.
- **Dunning:** automated reminder ladder (config per tenant): H-7/H-3/H-0 reminders → D+1/D+3/D+7 overdue → D+X `SUSPENDED` (storage: access revoked flag; owner notified) → D+Y lien/auction workflow checklist per Indonesian practice — ladder P0, lien checklist P1.
- **AR dashboard:** aging buckets (current/1–30/31–60/60+), collection rate, expected vs collected this month.
- **Refunds:** request → approval (role-gated) → gateway refund or manual disbursement → ledger entry.
- **Exports:** invoice/payment/ledger CSV; Accurate/Jurnal-compatible format P1; direct integration P2.
- **Month-end close view:** revenue recognized, deposits held, AR, refunds — P1.
#### 7.2.5 Customers (CRM-lite) — P0
- Customer directory: profile, KYC status, bookings, lifetime value, payment behavior score (on-time %), notes, WhatsApp deep link.
- Blocklist flag (rejected/evicted customers can't rebook silently).
#### 7.2.6 Reporting — P0 basic / P1 full
- P0: occupancy % (by location/AssetType), MRR/active leases, AR aging, bookings funnel (requests → approved → paid).
- P1: RevPAU (revenue per available unit), churn/retention cohorts, average tenure, promo performance, move-in/move-out forecast.
#### 7.2.7 Settings & Administration — P0
- Tenant profile, branding, domains; locations; users & roles (RBAC per Appendix C); document templates (contract, invoice, WhatsApp messages) with variable placeholders; automation toggles; audit log of all admin actions (immutable) — audit log P0, it protects the owner from his own staff.
---
## 8. Workflows & State Machines
These are normative. Any state not listed here does not exist; any transition not listed here is a bug.
### 8.1 Booking Lifecycle (RECURRING_LEASE variant)
```
DRAFT ──submit──▶ PENDING_APPROVAL ──approve──▶ APPROVED ──first payment──▶ ACTIVE
                    │        │                     │                          │
                    │        └─request info──▶ NEEDS_INFO ─customer replies─┐ │
                    │                              ▲────────────────────────┘ │
                    ├──reject──▶ REJECTED          │                          │
                    └──expire (SLA)──▶ EXPIRED     └─payment timeout─▶ LAPSED │
                                                                              │
        ┌─────────────────────────────────────────────────────────────────────┤
        ▼                          ▼                        ▼                 ▼
   RENEWING (auto, each cycle)  NOTICE_GIVEN ─end date─▶ MOVED_OUT ─settle─▶ CLOSED
        │ invoice unpaid past grace                        (final invoice,
        ▼                                                   deposit settlement)
   SUSPENDED ──payment──▶ ACTIVE
        │
        └──D+Y policy──▶ DEFAULT (lien workflow)
```
Guard rails:
- `APPROVED → ACTIVE` requires: contract e-signed (if tenant requires) **and** first invoice paid **and** unit assigned. All three, no exceptions, enforced in code.
- Asset is soft-reserved at `PENDING_APPROVAL` with a TTL (config, default 48h) so a slow approval can't cause double-booking, and a dead request can't hold inventory forever.
- Every transition writes: actor (user/system/webhook), timestamp, reason → audit trail.
NIGHTLY and DURATION_ORDER variants share `DRAFT → PENDING_APPROVAL → APPROVED → PAID` then diverge into `CHECKED_IN/PICKED_UP → CHECKED_OUT/RETURNED → CLOSED` with an `INSPECTION` step (deposit claim) for DURATION_ORDER. Full diagrams in Appendix B.
### 8.2 Invoice & Payment Lifecycle
```
SCHEDULED ─issue date─▶ ISSUED ─▶ (sent via WA/email) ─webhook─▶ PAID
                          │                                       
                          ├─due date passes─▶ OVERDUE ─▶ PAID (late) 
                          ├─admin adjusts─▶ superseded by CREDIT_NOTE + new invoice
                          └─booking cancelled pre-payment─▶ VOID
PAID ─refund approved─▶ PARTIALLY_REFUNDED / REFUNDED
```
- Invoices are immutable once ISSUED; corrections happen via credit note, never edit-in-place (audit + tax compliance).
- Recurring generator runs daily: for every ACTIVE lease, materialize next invoice at H-(lead time, default 7 days) before anchor date.
### 8.3 Asset Lifecycle
`AVAILABLE ⇄ RESERVED(booking TTL) → OCCUPIED → AVAILABLE`, with `MAINTENANCE` and `RETIRED` reachable from any state by admin action (occupied assets require lease resolution first).
### 8.4 Automation Catalog (v1 rules engine = hardcoded triggers with per-tenant toggles/params; visual builder is P2)
| # | Trigger | Action | Config |
|---|---|---|---|
| A1 | Booking submitted | WA to customer (received) + WA/console alert to approver role | SLA hours |
| A2 | Approval SLA breached | Escalate to Owner | on/off |
| A3 | Booking approved | Generate contract → e-sign request → payment link via WA | payment TTL |
| A4 | Payment webhook received | Match invoice → transition states → receipt via WA | — |
| A5 | Invoice H-7 / H-3 / H-0 | WA reminder with pay link | ladder steps |
| A6 | Invoice D+1 / D+3 / D+7 | Overdue WA escalating tone; D+X → SUSPEND + notify ops | X per tenant |
| A7 | Lease anchor date − lead time | Generate + send next invoice | lead days |
| A8 | Termination notice given | Compute final invoice + deposit settlement preview → route to Finance | notice days |
| A9 | KYC uploaded | Queue for verification; auto-approve booking if policy allows | policy |
| A10 | Deposit refund approved | Xendit payout + WA confirmation + ledger entry | approver role |
---
## 9. Customer Journey Map — Storage (First Tenant)
| Stage | Customer action | System behavior | Failure mode designed against |
|---|---|---|---|
| **Discover** | Lands on tenant storefront (ads/SEO/WA link) | Fast, branded, prices visible without login, size guide | "How much?" DMs; hidden pricing kills conversion |
| **Evaluate** | Compares unit sizes, checks availability & location | Real-time availability, photos, what-fits guide, cost calculator incl. prorate preview | Stale spreadsheet availability |
| **Book** | Picks unit type + move-in date, OTP signup, KYC upload, submits | Instant WA confirmation with SLA promise; soft-reserve | Silence after inquiry → customer books competitor |
| **Approve** | Waits | Approval workbench + SLA timer; approve → contract + payment link in one WA message | Requests lost in a shared inbox |
| **Pay** | Pays VA/QRIS/e-wallet | Webhook → auto-receipt → booking ACTIVE → access instructions sent | "Sudah transfer" screenshot disputes |
| **Move in** | Shows up | Ops checklist; unit → OCCUPIED | Unit not ready / double-assigned |
| **Live (months)** | Pays monthly | H-7/H-3/H-0 reminders, one-tap pay link, portal for invoices | Late payment from friction, not intent |
| **Wobble** | Misses payment | Dunning ladder → suspend → human call before DEFAULT | Revenue leakage; awkward ad-hoc chasing |
| **Grow/Shrink** | Needs bigger/smaller unit | Swap request in portal → prorated switch | Churn to competitor mid-need |
| **Exit** | Gives notice in portal | Notice-period enforcement, final invoice, deposit auto-settlement, refund via payout | Deposit disputes; ghost move-outs |
| **Return/Refer** | Gets win-back/referral WA later | CRM history preserved | P2 |
The same table structure applies to hotel (Discover → Book → Check-in → Stay → Check-out) and equipment (→ Pickup → Use → Return → Inspect) with verbs supplied by the booking model — journey stages are configuration, not new code paths.
---
## 10. Non-Functional Requirements
| Category | Requirement |
|---|---|
| Availability | 99.5% storefront/console v1 (single region, managed infra); payment webhook ingestion idempotent + replayable |
| Performance | Storefront LCP < 2.5s on 4G mid-range Android (majority device class); availability query < 300ms p95 |
| Security | RLS-enforced tenant isolation; RBAC; encrypted PII at rest (KTP, phone); audit log immutable; OWASP ASVS L2; rate-limited OTP |
| Compliance | Indonesian PDP Law (consent, deletion requests); tax-compliant sequential invoicing; PPN 11% handling; data in-region |
| Reliability | All money-adjacent jobs idempotent with dead-letter queues; double-entry ledger balances checked nightly |
| Auditability | Every state transition and admin action attributable to actor + timestamp, retained ≥ 7 years (tax) |
| i18n | Bahasa Indonesia + English, per-tenant default; IDR only v1, currency abstraction in schema |
| Accessibility | WCAG 2.1 AA on storefront |
---
## 11. System Architecture (Recommendation)
- **Stack:** Next.js (storefront SSR/SEO + console) · Node/TypeScript API (NestJS) or tRPC monolith · **PostgreSQL with RLS** · Redis (queues/cache) · BullMQ workers (invoicing, dunning, webhooks) · S3-compatible object storage (KYC docs, contracts).
- **Shape:** **Modular monolith.** One deployable, hard module boundaries (`catalog`, `booking`, `finance`, `notifications`, `tenancy`). Do not build microservices for one tenant; do keep module interfaces clean so extraction is possible at SaaS scale.
- **Integration boundaries (ports & adapters):** `PaymentProvider` (Xendit, Midtrans), `MessagingProvider` (WA BSP, email), `ESignProvider` (Privy/e-Meterai P1 — wet-sign PDF upload acceptable v1), `KYCProvider` (manual v1).
- **Events:** internal event bus (outbox pattern) — `BookingApproved`, `PaymentReceived`, `LeaseTerminated` etc. Automations (§8.4) subscribe to events; this is what makes the rules engine possible later without rewiring.
- **Environments:** dev/staging/prod; gateway sandbox tenants; seed data per booking model for testing all verticals from day one.
---
## 12. Metrics & Success Criteria
**North star (tenant #1):** % of revenue collected on time (target ≥ 95% within D+3).
| Metric | Baseline (manual) | Target 90 days post-launch |
|---|---|---|
| Booking request → approval time | Hours–days, untracked | < 4 business hours median |
| Invoice issuance | Manual, inconsistent | 100% auto-issued H-7 |
| Reconciliation effort | Manual matching | > 90% payments auto-matched |
| AR > 30 days | Unknown | < 5% of MRR |
| Storefront conversion (visit → request) | n/a | ≥ 3% |
| Self-serve renewals/terminations | 0% | ≥ 60% via portal |
| Occupancy visibility | None | Real-time, 100% accurate vs physical audit |
**Platform health:** zero cross-tenant data incidents (hard zero); new tenant provisioning < 1 day.
---
## 13. Phased Roadmap
| Phase | Timeline | Scope | Exit criteria |
|---|---|---|---|
| **0 — Foundation** | Weeks 1–4 | Tenancy + RLS, auth/RBAC, domain model, asset registry, Xendit sandbox, WA sandbox | Second dummy tenant provisioned via config only |
| **1 — Storage MVP** | Weeks 5–12 | Storefront (catalog, booking, checkout), approval workbench, RECURRING_LEASE engine, invoicing + webhooks, dunning ladder, customer portal (view/pay/renew/terminate), P0 reports | Tenant #1 live; one full cycle (book→pay→invoice→renew) with zero manual finance steps |
| **2 — Finance depth & automation** | Weeks 13–20 | Deposit settlement + payouts, refunds, credit notes, maker-checker, unit map, swap requests, e-sign, accounting export, escalations, month-end view | Finance closes a month in < 1 day; AR dashboard trusted as source of truth |
| **3 — Multi-vertical proof** | Weeks 21–32 | NIGHTLY + DURATION_ORDER booking models, pooled inventory flag, seasonal pricing, second tenant in a different vertical onboarded | A hotel/kost or equipment tenant live **without code changes** — the extensibility thesis validated or falsified here |
| **4 — SaaS-ready (optional)** | Post-validation | Self-serve tenant signup, billing/metering of tenants, visual automation builder, OTA channel sync (hotel), API/webhooks for tenants, KYC automation | Decision gate: license externally or keep as internal moat |
Monetization decision deliberately deferred to the Phase 4 gate per owner direction; Phases 0–3 are architected so that gate is a pricing decision, not a rebuild.
---
## 14. Risks & Mitigations
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Over-generalization slows v1 (building for hotels nobody asked for yet) | High | High | BookingModel abstraction is cheap (an enum + strategy classes); everything else ships storage-only. Phase 3 is where generalization is *proven*, not Phase 1. |
| WhatsApp BSP template approval delays / policy changes | Medium | High | Submit templates week 1; email fallback for every message; abstract behind MessagingProvider |
| Payment webhook edge cases (double fire, late fire, VA expiry) | High | High | Idempotency keys, reconciliation cron against gateway API, dead-letter queue with alerting |
| Tenant #1 staff bypass the system (keep using WhatsApp/Excel) | High | High | Make Console faster than the spreadsheet; approval + payment can *only* happen in-system (payment links only generated by platform); owner dashboards create top-down pull |
| KYC/PII breach | Low | Severe | Encryption at rest, access-logged doc views, retention policy, RLS |
| Prorate/tax edge cases create invoice disputes | Medium | Medium | Golden test suite for billing math (proration, PPN inclusive/exclusive, credit notes) before launch; finance sign-off on 20 synthetic scenarios |
| Solo/small team building both surfaces | High | Medium | Modular monolith, managed infra, buy-not-build for payments/messaging/e-sign; ruthless P0 discipline |
---
## 15. Open Questions (need answers before build)
1. Does tenant #1 require physical access control integration (smart locks / gate PIN issuance on payment), or is access managed manually? (Affects Phase 2 scope materially.)
2. Is tenant #1 PKP (PPN-registered)? Determines tax line handling and e-Faktur relevance.
3. Notice period and lien/auction policy for defaults — what does their current rental agreement say? (Automation A6/A8 parameters.)
4. Deposit policy: fixed nominal or multiple of monthly rent? Refund SLA?
5. Existing customers migration: how many active leases to import, and is historical AR imported or started fresh?
6. Contract signing: is wet-sign PDF acceptable for v1, or is Privy/e-Meterai a launch requirement?
7. Who inside tenant #1 owns approval (single person or role pool), and what are working hours for SLA timers?
---
## Appendix A — Data Model Sketch (core tables)
`tenants` · `locations` · `users` / `roles` / `user_roles` · `customers` · `kyc_documents` · `asset_types` (attrs JSONB, booking_model enum, pricing JSONB) · `assets` · `bookings` (state, price_snapshot JSONB) · `booking_events` (audit) · `contracts` · `invoices` / `invoice_lines` · `payments` · `credit_notes` · `deposits` · `ledger_entries` (double-entry) · `notifications` · `automation_settings` · `promo_codes` · `audit_log`. Every table: `tenant_id NOT NULL` + RLS policy.
## Appendix B — Additional State Machines
**NIGHTLY:** `DRAFT → PENDING_APPROVAL → APPROVED → PAID → CHECKED_IN → CHECKED_OUT → CLOSED` (+ `NO_SHOW`, `EXTENDED` re-enters PAID for delta invoice).
**DURATION_ORDER:** `DRAFT → PENDING_APPROVAL → APPROVED → PAID(+deposit HELD) → PICKED_UP → RETURNED → INSPECTION → CLOSED` (inspection may raise damage invoice against deposit before release).
## Appendix C — RBAC Matrix (v1)
| Capability | Super Admin (Owner) | Ops Admin | Finance Admin | Viewer | Customer |
|---|---|---|---|---|---|
| Approve/reject bookings | ✔ | ✔ | — | — | — |
| Manage assets/pricing | ✔ | ✔ | — | — | — |
| Issue credit notes / refunds | ✔ | — | ✔ | — | — |
| Record manual payments | ✔ | ✔ (record) | ✔ (verify) | — | — |
| Reports | ✔ | limited | ✔ | ✔ | — |
| Tenant settings, users, templates | ✔ | — | — | — | — |
| Own bookings/invoices/portal actions | — | — | — | — | ✔ |
Platform Admin (us) sits above tenants: provisioning, flags, support impersonation (logged + consent-gated).
---
*End of PRD v1.0. Sections most in need of tenant #1 input before engineering kickoff: §15 open questions, §7.2.4 dunning parameters, §8.1 guard-rail thresholds.*
