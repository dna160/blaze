# PRD — Kebon Jeruk go-live on live data

Repo: `dna160/blaze`, branch off `main` (`ac2ece8` or later). Suggested path: `docs/PRD-kebon-jeruk-go-live.md`.

Sources:
- 11-05 meeting ("Rapat: Implementasi Sistem Sewa, KYC, Pajak, dan Laporan", Plaud).
- Client materials received 2026-11-08: a legacy Booqable contract and invoice, `QUOTATION_KEBON_JERUK.pdf` and `Layout_City_Storage_Kebon_Jeruk.pdf`.
- A code survey of `main` on 2026-11-08. File paths in this PRD come from that survey.

Data pack: the `go-live-data/` files listed in §11, built from the client materials. Commit them under `packages/database/prisma/data/kebon-jeruk/`.

## 1. Goal and the bar for "live"

Kebon Jeruk runs its real customers, units, contracts, invoices and payments on RentOS. The old system (Booqable) is retired for this branch. Setiabudi and Alam Sutera follow later; nothing here may assume one branch.

"Live" means all of the following are true:

1. Production holds only real data. There are no demo tenants, demo customers or demo passwords.
2. No customer can receive a message, contract or invoice that staff did not intend. This holds during the data migration too.
3. Every document a customer receives matches City Storage's own format: numbers, legal entity, bank account and terms.
4. Money cannot be marked as received unless it was received.

## 2. What the code does today that blocks go-live

These come from the code survey and from looking at production. Each one is a P0.

| # | Finding | Where |
|---|---|---|
| G1 | Production storefront serves the demo tenant "Gudang Aman Storage". Demo tenants (`gudang-aman`, possibly `griya-nginap`, `sewa-alat`), demo customers and test bookings are in the production database. The seed creates staff users that share the password `RentOS!Demo2026`. | `rentosstorefront-production` home page; `packages/database/prisma/seed.ts`; `NEXT_PUBLIC_DEV_TENANT_SLUG` |
| G2 | `PAYMENT_PROVIDER` defaults to mock. Mock confirms synchronously, so a customer pressing Pay in the portal marks the invoice PAID with no money moved. | `apps/api/src/payments/payments.module.ts`, `MockPaymentProvider` |
| G3 | Messaging has no global pause. Setting the org provider to `console_log` falls back to the env provider, so sending continues. | `resolveMessagingConfig` in `packages/database/src/messaging-config.ts` |
| G4 | The contract has no number, only `contractId.slice(0,8)`. Invoice numbers use the slug format `CITY-STORAGE-KEBON-JERUK/2026/11/000001`, and the month comes from server UTC. | `packages/database/src/invoice-number.ts`; `apps/api/src/documents/documents.service.ts:81` |
| G5 | The contract PDF carries five short placeholder clauses, not City Storage's 10-article bilingual T&C. The invoice has no bank account. The legal entity in the seed is wrong: it is "PT City Storage Indonesia" and should be **PT Servis Storej Indonesia**. | `documents.service.ts:134-140`; seed |
| G6 | `Tenant.isPkp` can only be set at creation, and the seed sets it to true. The legacy invoices carry no PPN. | `OrganizationService.provisionBranch`; seed |
| G7 | There is no bulk import for units, customers or contracts. The branch has 172 units and an existing customer book. | survey §8; `BUILD-SPEC.md` B7 |
| G8 | A branch-scoped Admin can change the organization's WhatsApp number, auto-reply and paired device. | `updateMessagingConfig` checks `assertOrgId` only |
| G9 | Auto-reply has no cooldown. Every inbound message triggers another reply; this was seen live in the meeting demo. | `whatsapp-webhook.service.ts` `autoReply` |

## 3. Scope by phase

- **P0 — before the first real customer.** §4 production readiness, §5 branch and catalog, §6 numbering, §7 documents, §8.1 tax settings, §9.1–9.3 WhatsApp safety, §10 migration.
- **P1 — first two weeks live.** §8.2–8.4 PPh withholding, §9.4–9.6 WhatsApp routing and access, §12 reports, §13 schedule clarity, §14 T&C money rules.
- **P2 — after Kebon Jeruk is stable.** §15: read-only API for Setiabudi, consolidated multi-branch, AI branch routing, Xendit per-branch keys.

Out of scope: smart locks, e-Meterai, invoice-payment refunds, promo logic. These are already listed as not done in HANDOFF.

## 4. Production readiness (P0)

### 4.1 Clean production

Run demo and production in separate databases. Keep the current Railway Postgres as **staging**, with demo data and seed users. Give production a fresh database with:

- migrations applied;
- a new seed mode, `SEED_MODE=production`, that only bootstraps the organization and the Kebon Jeruk tenant (§5) and creates no users, customers or demo data;
- users created from `go-live-users.csv` (§4.4).

The alternative is to purge demo rows from the current database. Do not take it: RLS policies and ledger rows make partial deletes risky, and a fresh database is cheap.

Acceptance:
- production `tenants` has exactly the City Storage tenants;
- `select count(*) from users where email like '%.test'` returns 0;
- the storefront root shows City Storage Kebon Jeruk.

### 4.2 Storefront tenant resolution

Remove `NEXT_PUBLIC_DEV_TENANT_SLUG` from production. Serve the storefront on the client's domain, mapped through `TenantDomain` (domain to be confirmed: §16 Q9). Until then, set it explicitly to `city-storage-kebon-jeruk`. Never leave it as `gudang-aman`.

### 4.3 Payments cannot fake success

- Add a startup guard: if `NODE_ENV=production` and `PAYMENT_PROVIDER` is missing or `mock`, online payment is **disabled**. Do not crash; disable.
- Add `featureFlags.onlinePaymentsEnabled`, per tenant, default false. While it is false:
  - the portal hides Pay and shows the bank transfer details (§7.3) and "send proof to WhatsApp CS";
  - the API refuses `POST /payments/checkout` with 409.
- Turn it on when the Xendit account the client is creating exists. Payment-gateway keys are sensitive, so the client creates the account.
- Acceptance: a production deploy with no Xendit keys cannot produce a SUCCEEDED payment except through manual record plus verify.

### 4.4 Users at go-live

- Bulk-create users from CSV (`go-live-users.csv`: email, display name, role, scope, branch).
- Each new user gets a set-password link by email or WhatsApp. No shared or default passwords.
- Console: Settings → Users → "Import CSV". Show a preview, then create.

### 4.5 Environment checklist

Write `docs/RUNBOOK-GO-LIVE.md` with values filled in and secrets referenced by name only:

- `PAYMENT_PROVIDER`;
- `MESSAGING_*` / `WA_BRIDGE_*`;
- `STOREFRONT_BASE_URL`;
- `STORAGE_PROVIDER=s3` (KYC documents must not sit on ephemeral disk);
- `ESIGN_PROVIDER`;
- `CORS_ORIGINS`;
- backups per `RUNBOOK-BACKUP.md`, with a test restore done once before go-live.

## 5. Branch and catalog from the client materials (P0)

### 5.1 Tenant profile, editable in the console

New page: **Settings → Branch** for an org-scoped Admin. Branch-scoped Admins can view it but not edit.

It edits fields that exist today (`name`, `legalName`, `isPkp`, `timezone`) plus these new ones:
- `Tenant.branchCode`: a short code, unique per org (e.g. `KBJ`), used in numbering;
- `Tenant.contact`: JSON with `whatsapp`, `phone`, `email`, `csDisplayName`;
- `Tenant.address`: string or JSON;
- `Tenant.operatingHours`: JSON;
- `Tenant.bankAccounts`: JSON array of `{bank, accountNumber, accountName, swift, showOnInvoice}`;
- `Organization.legalName`.

Every change is audited.

Initial values are in `kebon-jeruk-branch-profile.json`:
- legal entity PT Servis Storej Indonesia;
- address Kencana Tower Level B, Jl. Raya Meruya Ilir No. 88, Business Park Kebon Jeruk, Jakarta Barat 11620;
- CS WhatsApp +62 811-1877-838, phone 021-300 67838, `cs@citystorage.co.id`;
- BCA 6560238868 a/n PT Servis Storej Indonesia, SWIFT CENAIDJA;
- hours Monday–Friday 09:00–17:30 WIB.

### 5.2 Unit types (7, from the quotation)

| slug | name | size | price/month |
|---|---|---|---|
| small-storage | Small Storage | 4 m³ | 1.100.000 |
| medium-storage | Medium Storage | 8 m³ | 2.100.000 |
| large-storage | Large Storage | 16 m³ | 4.100.000 |
| x-large-storage | X Large Storage | 70 m³ | 7.200.000 |
| free-style-1 | Free Style 1 | ≤1 m³ | 320.000 |
| free-style-2 | Free Style 2 | 1–2 m³ | 610.000 |
| free-style-3 | Free Style 3 | 2–3 m³ | 900.000 |

All types: deposit 1× monthly rent, admin fee 0, minimum term 1 month, prices tax-exclusive (moot while non-PKP).

Changes needed:
- Sizes are **volume (m³)**. Add `sizeM3` (number) and `sizeLabel` (string, for bands like "1–2 m³") to the attributes schema. Show the label wherever `sizeM2` shows today: storefront cards, console catalog, PDFs.
- Extend `SizeClassSchema` (`packages/contracts/src/catalog.ts:25`) with `XLARGE` and `FREESTYLE`. The storefront size step groups by class, so the order is S, M, L, XL, then Free Style as its own group with explanatory copy.
- The storefront branch page lists the facilities from the quotation: 24-hour CCTV, fingerprint access, AC, pest control, fire extinguisher, flood-free, free insurance*.

### 5.3 Units (172, from the layout)

`kebon-jeruk-units.csv` has unit number, code, zone and type.

- 172 units numbered 1–179, in zones A (34), B (52), C (61) and D (25).
- The plan skips 4, 13, 14, 44, 104, 113 and 114. Do not create them.
- Codes keep the legacy form `STORAGE-<n>` (e.g. `STORAGE-9`), so migrated contracts, customers' existing paperwork and the door labels all agree.
- Add `Asset.zone` (nullable string) and index it. The console unit map groups by zone, falling back to the code prefix when zone is null.
- **The unit-to-type mapping is missing.** The layout doesn't say which units are Small, Medium and so on. Only STORAGE-9 = Small is known, from the legacy contract. The importer must reject a unit row without a type, so go-live is blocked until the client fills the `unit_type_slug` column or it comes from the Booqable export.

**Bulk import (new).** Console → Inventory → "Import units (CSV)", for an org-scoped Admin.
- Upsert by `(tenantId, code)`.
- Dry run first: per-row errors (unknown type slug, duplicate code, missing zone), then confirm.
- It never deletes. A unit missing from the file is reported, not removed.

## 6. Numbering (P0)

Customers, staff and accountants must recognise numbers. Contracts and invoices must be separate sequences: one contract has many invoices, and a unit added later gets its own contract (decided in the meeting).

### 6.1 Legacy format

Booqable printed:
- Contract `#5-2026-36-39`, dated 18-05-2026 (booking #46).
- Invoice `#6-2026-36-122`, dated 05-06-2026 (same customer, same booking).

Reading: `{month}-{year}-{customerNumber}-{runningCounter}`.
- 36 appears on both documents, so it is most likely the Booqable customer number.
- 39 and 122 are separate running counters for contracts and invoices.
- Confirm: §16 Q1.

The meeting also asked for the branch code, needed once there are several branches.

### 6.2 Model

- `Customer.customerNumber`: Int, unique per **organization** (one customer can rent at two branches). Assigned on creation from an atomic `customer_number_counters(organizationId)`. Migrated customers keep their Booqable number, and the counter starts after the highest imported one.
- `Contract.contractNumber`: String, unique per tenant.
- `Invoice.invoiceNumber`: existing; new format.
- One counter table for document sequences: `document_number_counters (tenantId, kind CONTRACT|INVOICE|CREDIT_NOTE, scope, value)`.
  - `scope` is `'all'` for a running counter or `'YYYY-MM'` for a monthly one, depending on the format.
  - It replaces `InvoiceNumberCounter`. Migrate the existing counter values into it.
- Format per tenant: `Tenant.numbering` JSON, e.g.
  `{ "contract": "{BRANCH}-{M}-{YYYY}-{CUST}-{SEQ}", "invoice": "{BRANCH}-{M}-{YYYY}-{CUST}-{SEQ}", "seqReset": "never" }`
  - Tokens: `{BRANCH}` = `branchCode`, `{M}` / `{MM}`, `{YYYY}`, `{CUST}` = `customerNumber`, `{SEQ}` / `{SEQ:4}` (zero-padded).
  - Default for Kebon Jeruk: `KBJ-{M}-{YYYY}-{CUST}-{SEQ}`, giving e.g. `KBJ-11-2026-36-40`. Drop `{BRANCH}-` if the client wants pure continuity: §16 Q1.
- **Month and year come from `Asia/Jakarta`.** The tenant timezone, not server UTC: an invoice issued at 06:00 WIB on the 1st must not get the previous month.
- Counters for migrated tenants start above the highest legacy number (39 and 122 in the example; take the real maximum from the export).
- Scheduled invoices keep their provisional `SCHEDULED/...` number until issue, as today.

### 6.3 Where numbers show

Each document shows its own number:
- contract PDF: "Contract #";
- invoice PDF: "Invoice #";
- console booking page: header and schedule rows;
- client detail;
- portal;
- WhatsApp templates that mention a contract or invoice;
- CSV/XLSX exports.

Search in the console (clients, invoices) matches contract and invoice numbers.

## 7. Documents (P0)

### 7.1 Contract PDF in City Storage's format

Reproduce the legacy layout (`documents.service.ts renderContract`).

**Page 1 header**
- Top left: customer block — name, company (if business), address, email, phone.
- Top right: branch block from `Tenant` (§5.1), with the City Storage logo.
- Then: Date, Booking #, From, Until, and the title **Contract #{contractNumber}**.

**Lines**
- For each rented unit: the type line ("1x Small Storage — Monthly — price") and the unit sub-line ("Storage — STORAGE-9").
- Then Subtotal, PPN (only if PKP), Total, and Security deposit.

**Body**
- The **full bilingual T&C** from `contract-terms-id-en.md`: two columns, Indonesian left and English right, articles I–X verbatim.
- Store the text per organization: `Organization.contractTerms` (markdown, versioned). Each contract stores the `termsVersion` it was generated with, so a signed contract always re-renders with the terms that were signed.
- Then the signatory declaration (points 1–2) and the signature block.

### 7.2 Signature

The legacy contract shows a hand-drawn signature and a "CONFIRMED" stamp.
- Add a signature pad (canvas, touch and mouse) to the portal contract step, alongside today's "upload signed scan". Store it as PNG next to the contract, together with signer name, timestamp, IP and user agent.
- Render it into the PDF signature block, and stamp "CONFIRMED" once staff approve.
- The click-accept / OTP path via `OrderAcceptance` stays available. `ESIGN_PROVIDER` stays `mock` until there is a decision on Privy or Mekari.

### 7.3 Invoice and proforma PDF in City Storage's format

- Same header as the contract. Then Invoice date, Due date, Booking #, From, Until, and the title **Invoice #{invoiceNumber}**.
- Lines, Subtotal, PPN (if PKP), Total, Security deposit (on the proforma only), Due.
- For a business customer: the company name and NPWP.
- When PPh is withheld (§8), the breakdown from §8.3.
- **Payment Method** block from `Tenant.bankAccounts` (`showOnInvoice`): "Bank Central Asia - 6560238868 / PT Servis Storej Indonesia / Swift code: CENAIDJA". If online payment is enabled, add the portal link too.

### 7.4 Document vault on the client page

Console client detail (`apps/console/src/app/clients/[id]/page.tsx`) gets a **Documents** section:
- generated contract;
- signed contract (upload or e-signature);
- every invoice PDF;
- payment proofs;
- KYC files: KTP, selfie, NIB, NPWP, PPh support.

All documents open in a new tab, whatever their review status. Today approved KYC files cannot be reopened.

Access:
- KYC files: `approve_booking` or `approve_deposit_refund`, as now;
- contracts and invoices: any staff role in scope.

Every open of a KYC file writes an audit row (who, when, which file).

## 8. Tax (P0: settings; P1: withholding)

**Status of these rules.** The rates and the PPh mechanism below are what was said in the meeting. Finance owes worked examples (action item from 11-05). Build the mechanism configurable and validate the numbers against those examples before enabling withholding for any customer. This PRD is not tax advice.

### 8.1 PPN per branch (P0)

- `Tenant.isPkp` becomes editable in Settings → Branch (§5.1).
- The change applies only to invoices issued after it. Already-issued invoices never change.
- Kebon Jeruk starts with `isPkp=false`: legacy invoices carry no PPN, and in the meeting staff said "kita nggak ada tax". §16 Q2.

When `isPkp=false`, tax rows and columns disappear from:
- invoice and contract PDFs;
- the portal quote;
- exports (§12.4).

This is the "toggle tax on/off" asked for in the meeting.

### 8.2 Company PPh question (P1)

The current wording reads as "are you charged PPh?". The meeting agreed to change it to "will you withhold PPh?".

- Storefront `apps/storefront/src/app/portal/kyc/page.tsx:144-147` becomes:
  - heading **"Apakah akan memotong PPh?"**;
  - text: "Will your company withhold income tax (PPh) when paying this rental? If you are not sure, ask your finance team — we can change this later."
- Mirror the label in the console KYC and client pages.
- `Customer.pphWithheld` stays as the stored answer.
- Extend it with `Customer.pphType`: `PPH_4_2_FINAL` (default for space rental, 10%) or `PPH_23` (2%; mentioned in the meeting's Rp6 juta example). The rate lives in config: `Organization.taxConfig.pphRates`.
- Staff can set or correct both fields on the client page, audited.

### 8.3 Invoice shows the withholding; the total does not change (P1)

The invoice total stays the legal amount owed: DPP + PPN. The customer pays the total minus the withheld PPh and hands over a bukti potong.

The meeting was explicit: "invoice-nya tetap harus sama, nanti kita yang potong".

For customers with `pphWithheld=true`, the invoice PDF and portal show:

```
DPP (Dasar Pengenaan Pajak)                     1.000.000
PPN 11%                                           110.000   (only if branch is PKP)
Total invoice                                   1.110.000
PPh Final 4(2) 10% dipotong oleh penyewa         (100.000)
Jumlah yang ditransfer                          1.010.000
```

Non-PKP branch: Total 1.000.000, withheld 100.000, transfer 900.000.

### 8.4 Settling an invoice net of withholding (P1)

Manual payment record (`POST /payments/manual`) gains:
- `amount`, defaulting to the total minus expected withholding;
- `pphWithheldAmount`;
- an optional `buktiPotong` upload (it can arrive later).

The invoice becomes **PAID** when `amount + pphWithheldAmount = totalAmount`, within Rp 1 rounding.

Partial payments:
- Add an invoice state or field for amount outstanding, so a short payment leaves the invoice open with the balance shown.
- This is also the state the earlier overpayment correction needed.

Ledger:
- New account `PREPAID_TAX_PPH` (asset).
- On verify: Dr Cash (amount), Dr PREPAID_TAX_PPH (withheld), Cr Accounts Receivable (total).
- "Bukti potong outstanding" shows on the client page and in a finance report until the document is uploaded.

The Xendit path is unchanged: online payments pay the full total. Withholding customers pay by transfer and are recorded manually.

## 9. WhatsApp (P0: safety; P1: routing and access)

Messages go through the linked-device bridge (`apps/wa-bridge`, provider `whatsapp_linked`) from the admin number. Per the meeting, that number is for system messages (contracts, invoices, OTP, reminders). Conversations belong to each branch's CS number.

### 9.1 Global pause (P0)

`Organization.messagingPaused` (boolean), plus `pausedReason`, `pausedBy` and `pausedAt`.

While paused:
- every outbound path refuses before it reaches a provider: API notifications, the worker's dunning, renewal and reminder jobs, the auto-reply, and inbox replies;
- each refusal writes a `Notification` row with status `SUPPRESSED` and the reason, so nothing is silently lost and staff can see what would have gone;
- **inbound still records.**

The check is in one place, the shared notify path that both the API and the worker use, so a new trigger cannot bypass it.

Console:
- a red banner on every page while paused;
- the toggle in Settings → Messaging, org-scoped Admin only, with a confirmation.

**The migration importer (§10) refuses to run unless messaging is paused.**

Acceptance: with pause on, approving a booking, running the dunning job and replying in the inbox each produce a SUPPRESSED row, and the bridge receives zero send calls.

### 9.2 Auto-reply once per conversation (P0)

- Reply at most once per phone number per `autoReplyCooldownHours` (default 12).
- Skip the auto-reply if a human replied in that conversation within the cooldown.
- Never auto-reply to an outbound echo.
- Store `lastAutoReplyAt` per `(organization, phone)`.
- Acceptance: three inbound messages within a minute produce one auto-reply.

### 9.3 Bridge safety (P0)

- Persist the daily cap counter in the `wa` schema; today it is in memory and resets on restart.
- Keep the current pacing: at least 3 s plus jitter, a typing indicator, and a cap of 1000 per day (as agreed in the meeting).
- Show today's count and the cap in Settings → Messaging.

### 9.4 Route customers to their branch CS (P1)

The auto-reply text gains placeholders:
- `{branchName}`, `{branchWhatsapp}` and `{branchPhone}`, from §5.1;
- `{allBranches}`: a list of "Kebon Jeruk: +62 811-1877-838 …" lines.

Logic:
- If the customer is known and has rented at one branch, use that branch's contact.
- If they rent at several branches, or the number is unknown, use the `{allBranches}` variant.

Default copy (bilingual), along the lines of: "Halo! Nomor ini hanya untuk notifikasi otomatis (kontrak, invoice, pengingat). Untuk pertanyaan, hubungi CS {branchName} di WhatsApp {branchWhatsapp}."

### 9.5 Inbox access (P1)

Today every staff role sees the inbox, and Settings → Messaging is editable by any Admin. Target:

- **Settings → Messaging** (pairing, auto-reply, pause): org-scoped Admin only, i.e. Super Admin, as stated in the meeting. Fix G8 on the API side as well: check `hasOrganizationScope`, not just the role.
- **Inbox**: a capability `read_messages`. ADMIN, SUPERVISOR and STAFF have it; FINANCE does not. It stays branch-scoped as today. Speaker 3 wanted staff to see it; the meeting left this open, so the matrix in `docs/RBAC.md` is the place to confirm (§16 Q6).

### 9.6 AI branch triage (P2)

For unknown numbers: ask which branch and route accordingly. Not before §9.4 is live and the copy is approved.

## 10. Migration from Booqable (P0)

The legacy PDFs are Booqable exports (the PDF title is "Contract #… | City Storage Kebon Jeruk | Booqable"). Booqable can export CSVs of customers, orders and documents, and has a REST API. Ask the client for an export or an API key (§16 Q4).

### 10.1 Importer

Command: `pnpm migrate:legacy --tenant city-storage-kebon-jeruk --dir ./import [--apply]`. Optionally a console upload with the same engine.

Inputs (templates in the data pack):
- `migration-customers.csv`;
- `migration-rentals.csv`: one row per active unit rental, with contract number, unit code, start date, current period end, monthly price, deposit held, paid-through date, status, and the signed contract PDF path;
- `migration-open-invoices.csv`: invoices unpaid at cut-over.

Rules:
- **Dry run by default.** Report per row what would be created or updated and every validation error: unknown unit code, unit already occupied, missing phone, overlapping dates, deposit mismatch. `--apply` runs only if the dry run has zero errors.
- Refuses to run unless `messagingPaused=true` (§9.1).
- Idempotent: keyed by legacy customer number, booking number and invoice number. Re-running updates and never duplicates.
- Customers keep their legacy `customerNumber`; contracts and invoices keep their legacy numbers. Counters start above the maximum imported (§6.2).
- Imported KYC status is `VERIFIED_LEGACY`, so imported customers are not asked to redo KYC. It is distinguishable from RentOS-verified.
- Rentals become ACTIVE, with the unit OCCUPIED and the deposit recorded as **held** at the amount actually held. The example contract holds Rp 980.000 against a Rp 1.100.000 rent; keep the real figure and do not recompute.
- The next scheduled invoice is generated from `paid_through`. No back-invoicing of past periods.
- Signed legacy contract PDFs attach to the imported contract (§7.4).
- Ledger: opening balances. Dr AR for open invoices, Cr Deposit Liability for deposits held, balanced against an `OPENING_BALANCE` equity account. Imports never post revenue.

### 10.2 Cut-over runbook

1. Pause messaging.
2. Import into a **staging copy** of production and reconcile against Booqable totals: number of active rentals, AR total, deposits held total.
3. Import into production.
4. Spot-check 10 customers with the branch.
5. Freeze Booqable.
6. Unpause messaging. Before doing so, review the SUPPRESSED queue and confirm nothing in it should go out.

## 11. Data pack (built now, in `go-live-data/`)

| File | What it is | Status |
|---|---|---|
| `kebon-jeruk-branch-profile.json` | Legal entity, address, CS contacts, bank account, hours, facilities, commercial rules from the T&C, legacy numbering notes | Ready. Map coordinates and PKP to confirm. |
| `kebon-jeruk-unit-types.csv` | The 7 types and prices from the quotation | Ready. Confirm how Free Style works (§16 Q3). |
| `kebon-jeruk-units.csv` | 172 units, codes `STORAGE-n`, zones A–D from the layout | **Type per unit missing** (only STORAGE-9 known). Zone of units 92–100 and unit 38 to confirm. |
| `contract-terms-id-en.md` | The full T&C, articles I–X, Indonesian and English, verbatim with reconstructed clause numbers, plus the signatory declaration | Ready. Ask the client to confirm it is their current version. |
| `migration-customers.csv`, `migration-rentals.csv`, `migration-open-invoices.csv` | Import templates (headers and one fictitious example row) | Waiting on the Booqable export. |
| `go-live-users.csv` | User import template | Waiting on the client's user list. |

## 12. Reports (P1)

### 12.1 Date ranges

Every report and export gets a from–to picker with presets:
- this month, last month;
- this quarter;
- custom.

For the "1–31 October" case from the meeting, the custom range must take exactly those dates.

AR aging keeps "as of" plus the 30/60/90 horizon. Its preset also offers an explicit as-of date with the horizon counted from it, which is the behaviour finance expected.

### 12.2 Excel and Google Sheets friendly exports

- Add **XLSX** exports (`exceljs`) for invoices, payments, ledger, contracts, AR aging and the client list. Use typed cells: dates as dates, amounts as numbers in IDR format, frozen header, autofilter.
- Keep CSV, but add a UTF-8 BOM so Excel reads it correctly.
- Add the contracts export button that is missing from the console today.

### 12.3 AR aging download and per-customer breakdown

- AR aging gets "Download (XLSX)": one row per open invoice with customer, customer number, contract #, invoice #, unit, due date, days overdue, bucket and amount.
- Add a per-customer summary tab.
- On screen, each bucket total expands to the customers in it. The meeting asked to see "who owns this" without opening invoices one by one.

### 12.4 Tax columns follow PKP

When the branch is non-PKP, tax columns are hidden from screens and exports. Month-end `taxPayable` shows "—" with a note.

## 13. Payment schedule clarity (P1)

- Every schedule row shows its invoice number and the contract number and unit: in the console booking page, the client page and the portal.
- The client page groups schedules by contract (one contract per unit-taking, §6), so a customer with two units taken at different times shows two schedules.
- Add a console page for RentalOrders (the API exists, the page does not).

## 14. Money rules from the T&C (P1, each behind a per-branch flag, default off until the client confirms)

| Rule (T&C article) | Build |
|---|---|
| Late payment of an extension: 1% per day of the bill, maximum 14 days, then the extension is void (V.3) | Worker job adds a `LATE_FEE` line to the open invoice daily, capped at 14 days. Day 15 hands off to the existing suspension and void path. Amounts in `Tenant.featureFlags.lateFee` = `{ratePerDay: 0.01, maxDays: 14}`. |
| Overstay after the lease ends: 1% per day, maximum 30 days (VI.4) | Same mechanism on a final invoice, from end date until the unit is marked vacated. |
| Overtime access: Rp 50.000 per hour outside hours (II.8) | "Add charge" on the console booking page: an ad-hoc line on the next invoice, or a one-off invoice, with type `OVERTIME`. |
| Deposit returned within 30 days after the lease ends (IV.3) | A deposit-refund task appears at move-out, due at +30 days. It is red on the deposits page when overdue. |
| No access while in arrears (V.5, VI.7) | A badge "Akses ditolak — tunggakan" on the unit and client pages for the front desk. |

## 15. Later (P2)

- Read-only API for Setiabudi's IT team. `GET /external/bookings` and `/external/invoices` exist, are read-only and unscoped. Add `/external/payments` with status filters, plus key scopes and rotation, before handing out a key.
- Consolidated organization reports and AR across branches.
- Xendit keys per branch, if branches bank separately.
- AI branch triage (§9.6).

## 16. Questions for the client (owner: Johnson)

1. **Numbering.** Is `5-2026-36-39` = month-year-customerNumber-runningCounter? Should new numbers carry `KBJ-` in front, or continue exactly as before?
2. **PKP.** Is PT Servis Storej Indonesia PKP? Should Kebon Jeruk invoices carry PPN from go-live?
3. **Free Style.** Is it a shared area sold by volume band (pooled) or fixed units? If fixed, which unit numbers?
4. **Booqable.** Can you give us an export (customers, orders, invoices, documents) or an API key? What is the cut-over date?
5. **Unit types.** Which unit numbers are Small, Medium, Large or XL? Is unit 38 in Zone D? Are units 92–100 in Zone B or C?
6. **Inbox access.** Who reads customer WhatsApp in the console: Admin, Supervisor and Staff? Not Finance?
7. **T&C money rules (§14).** Should the system apply them automatically from day one, or should staff apply them manually?
8. **Invoice due date.** Legacy invoices are due 15 days after issue, and issued after the period starts. RentOS issues 7 days before the due date, which is the period start. Keep the RentOS rule?
9. **Domain.** Which domain will the storefront use (for example `sewa.citystorage.co.id`)?
10. **Tax examples.** We still need finance's worked examples for PPN and PPh (the 11-05 action item) before enabling §8.3–8.4.
