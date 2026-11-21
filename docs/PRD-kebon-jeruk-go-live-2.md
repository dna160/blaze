# PRD: Kebon Jeruk go-live, part 2

**Repo:** `dna160/blaze`. Branch off `main` at `a6b5a91` or later. Suggested path: `docs/PRD-kebon-jeruk-go-live-2.md`.

**What this follows on from:** `docs/PRD-kebon-jeruk-go-live.md` (part 1). Most of part 1 is built (see §1). This document holds:
- everything still open from part 1;
- everything raised at the **11-17 product walkthrough** with City Storage ("Tinjauan produk: Alur operasional City Storage di Rent OS", Plaud recording).

The status facts come from a code survey of `main` at `a6b5a91` on 2026-11-21.

**Priority rule.** City Storage has now asked twice (11-05 and 11-17) for reports over any date range, CSV export, and a deposit report. These are P0 and come first. Nothing in §3 waits on anything else.

---

## 0. How to use this document

- Sections §2–§11 are workstreams. Each item has a priority, a "today" line (what the code does now), the requirement, and acceptance criteria.
- P0 means it must be done before City Storage starts its own testing on a clean branch. P1 means it must be done before cut-over from Booqable. P2 comes after Kebon Jeruk is live.
- §12 lists the decisions the client still owes. Build the defaults written here. Each default sits behind config, so changing it is a settings edit, not a rewrite.
- **Language.** All new console strings go through the i18n layer from §9.1 and ship with Indonesian as the default.

## 1. Baseline: done in part 1 (do not rebuild)

These were checked against code on 2026-11-21.

| Area | Part 1 § | Status |
|---|---|---|
| Production seed mode, no demo data in prod | 4.1 | Done |
| Online payments off unless Xendit is configured | 4.3 | Done |
| User CSV import with set-password links | 4.4 | Done |
| Settings → Branch: profile, contacts, bank, PKP, numbering | 5.1 | Done |
| XL and Free Style size classes, m³ labels, unit import, zones | 5.2–5.3 | Done (STORAGE-103 and STORAGE-105 still have no type) |
| Contract, invoice and customer numbering in City Storage's format | 6 | Done, except search (see §8.4) |
| Contract PDF with full bilingual T&C, signature pad, CONFIRMED stamp | 7.1–7.2 | Done |
| Invoice PDF in City Storage's format, with bank block and NPWP | 7.3 | Done |
| Client document vault, with KYC opens audited | 7.4 | Done |
| PPN per branch (`isPkp`); company PPh question and tax profile | 8.1–8.2 | Done (tax still shows in reports and exports, see §2.6) |
| Messaging pause, auto-reply cooldown, bridge daily cap, branch routing, inbox capability | 9.1–9.5 | Done |
| Booqable migration engine, legacy archive (`/legacy`), legacy hold | 10 | Done (re-sync is manual) |
| Cancel a booking after approval | — | Done as a **direct** action. §4.1 replaces it with request and approval |
| One-off branch wipe (`ONE_OFF_WIPE`) | — | Done. §7.1 adds what it is missing |

**Still open from part 1, carried into this document:**
- 8.3–8.4 PPh withholding and net settlement → §10.1
- 12.1–12.4 reports → §2
- 13 RentalOrders page → §10.2
- 14 T&C money rules → §10.3
- 15 external API → §11

---

## 2. Reporting (P0 unless marked)

**Today:**
- Month-end close is a single `<input type="month">` calling `GET /reports/month-end?year&month`.
- Month boundaries are computed in **UTC**, not Asia/Jakarta.
- The console sends exports for the selected month only, even though the API accepts `from`/`to`.
- There is no free date range anywhere, no sales report, and no deposit report.
- Month-end and AR aging cannot be exported.
- The console has no button for the existing contracts export.

### 2.1 One date-range control, used by every report

Build a shared `ReportRange` component and API convention.

**Presets** (Indonesian labels first):
- Hari ini / Today
- Kemarin / Yesterday
- Minggu ini / This week (Mon–Sun)
- Minggu lalu / Last week
- Bulan ini / This month
- Bulan lalu / Last month
- Kuartal ini / This quarter
- **Rentang khusus / Custom** (from and to date pickers)

**Range semantics:**
- `from` and `to` are **inclusive calendar dates in the branch timezone** (`Tenant.timezone`, Asia/Jakarta).
- The API converts them to `[from 00:00 WIB, to+1 00:00 WIB)`.
- One helper in `packages/domain` does this conversion. Every report and export uses it. Replace `Date.UTC` month math in `reporting.service.ts`.
- Acceptance: a payment at 2026-11-01 06:30 WIB (2026-10-31 23:30 UTC) falls in November.

**URL and state:**
- The selected range is held in the page URL (`?from=2026-11-01&to=2026-11-17`) so a report can be bookmarked and shared.
- The last range used is remembered per user in `localStorage`.

**Layout:** put the range control at the top of the reports page, or in a left column as in the tool City Storage uses today. Every section below reads from it.

### 2.2 Sales report — live, any range (new)

This is the report City Storage described: "how much did we sell this week". Finance staff (Risa) use it daily or weekly to enter bank *mutasi*. It is not month-end close.

**Endpoint:** `GET /reports/sales?from&to&groupBy=day|week|month`

**Sections:**
1. **Summary:**
   - invoices issued (count and amount)
   - payments received (count and amount, by method: bank transfer, cash, Xendit VA/QRIS/e-wallet/card)
   - deposits received
   - new rentals started
   - rentals ended
   - credit notes
2. **Daily table**, one row per day in range:
   - invoiced
   - received
   - deposits received
   - deposits refunded
   - net cash in
3. **Transaction list**, one row per payment:
   - date and time (WIB)
   - customer and customer #
   - contract #
   - invoice #
   - unit
   - method
   - reference (bank ref, Xendit ID)
   - amount
   - status (`SUCCEEDED`, `PENDING verification`, `FAILED`)
   - recorded by
   - verified by
   - Filters: status ("sukses saja" / successful only is the default), method.

Definitions, written on the page:
- "Penjualan / Sales" = invoices issued in range.
- "Penerimaan / Received" = payments that reached SUCCEEDED in range, dated by `paidAt`, not `createdAt`.
- Deposits are shown separately and never counted as sales.

Access: `run_reports`. The capability decision is in §6.2.

Export: CSV for each section (§2.4).

### 2.3 Month-end close accepts any range

**Today:** the month picker only.

**Requirement:**
- Month-end close becomes "Ringkasan keuangan / Financial summary".
- It runs over any range from §2.1. "Bulan ini" and "Bulan lalu" stay as presets, so closing a month is one click.
- Tiles keep their meaning, computed over `[from, to]`:
  - revenue recognized
  - invoiced
  - received
  - AR at the end of range
  - deposits held at the end of range
  - tax payable (hidden when not PKP, see §2.6)
- A note on the page: "AR dan deposit dihitung per akhir rentang / as of the end of the range".

**Export:** CSV with one row per tile and one row per ledger account (opening balance, debit, credit, closing balance) for the range.

**Acceptance:**
- Range 1–17 Nov returns figures that match the sum of ledger entries in that window.
- Range 1–30 Nov returns the same figures as today's November month-end.

### 2.4 CSV export on every report

Every report section gets **Unduh CSV / Download CSV**, using the current range. Required set:

| Export | Status |
|---|---|
| `invoices.csv` | exists; wire to range |
| `payments.csv` | exists; wire to range; date by `paidAt` |
| `ledger.csv` | exists; wire to range |
| `contracts.csv` | exists; **add console button**; wire to range |
| `sales-daily.csv`, `sales-transactions.csv` | new (§2.2) |
| `financial-summary.csv` | new (§2.3) |
| `ar-aging.csv` | new (§2.5) |
| `deposits.csv` | new (§3) |
| `clients.csv` | new: the client list with health, outstanding and next due |

**CSV format** (keep what exists and extend it):
- UTF-8 with BOM (already done), comma-separated, header row.
- Amounts as plain integers in rupiah with no thousands separator, so they sum correctly in Sheets and Excel.
- Dates `YYYY-MM-DD` and timestamps `YYYY-MM-DD HH:mm` in **WIB**.
- Filename: `{branchCode}_{report}_{from}_{to}.csv`.

XLSX stays P2. CSV with BOM opens cleanly in both Google Sheets and Excel, which is what was asked.

### 2.5 AR aging: export and drill-down (P0)

- Keep the buckets: overdue (current, 1–30, 31–60, 60+) and coming due. The team accepted buckets for AR as long as sales gets a date range (§2.2).
- Each bucket total expands into its invoices. Columns:
  - customer and customer #
  - contract #
  - invoice #
  - unit
  - due date
  - days overdue
  - amount outstanding
  - last reminder sent
- A "per customer" toggle groups the same rows by customer.
- `ar-aging.csv` contains the invoice-level rows plus a `bucket` column.

### 2.6 Tax columns follow PKP (P1)

When the branch has `isPkp=false`:
- hide tax columns in exports and on screen;
- the summary shows "Tidak PKP" instead of a tax payable figure.

The PPN label on PDFs is hardcoded as "PPN 11%". Derive it from the configured rate (§12 Q4).

---

## 3. Deposit report (P0, new)

**Today:**
- The deposits page lists customer, unit, amount, remaining and status, with no dates, filters, totals or export.
- The `Deposit` model has no paid date, no refund-requested date or requester, and no refund due date.
- A deposit row exists only after the money lands.

### 3.1 Data

Add to `Deposit`:
- `receivedAt` — when the money arrived. Backfill from the paying invoice's `paidAt`. For legacy rows use the import date and mark them `source=LEGACY`.
- `refundRequestedAt`, `refundRequestedByUserId`
- `refundDueAt` — lease end + 30 days, per T&C IV.3
- `customerId` — denormalised for reporting
- `source` — `RENTOS` or `LEGACY`

Record each movement as a deposit event (`HELD`, `APPLIED x`, `REFUND_REQUESTED`, `REFUNDED`) so a range report can show movement, not just current state.

### 3.2 Console: Deposit page becomes a report

**Filters:**
- the §2.1 range, applied to movement dates
- status
- unit type
- source
- "refund overdue" (`refundDueAt` < today and not refunded)

**Columns:**
- customer and customer #
- contract #
- unit
- amount
- received date
- applied
- remaining
- status
- lease end
- refund due
- refunded date
- payout reference

**Totals strip:**
- held at end of range
- received in range
- applied in range
- refunded in range
- refunds overdue (count and amount)

The page export is **`deposits.csv`**: one row per deposit, with the columns above.

**Acceptance:** the "held" total equals the `DEPOSIT_LIABILITY` ledger balance at the end of the range. After the Booqable import that figure is Rp 52.67 M per the migration audit. Show a warning badge if the two disagree.

---

## 4. Booking changes need approval (P0)

**Today:**
- `POST /bookings/:id/reject` cancels an approved booking. ADMIN and SUPERVISOR of either scope can do this directly, with a `window.prompt` asking for the reason.
- The check-in date cannot be changed at all.
- No generic change-request model exists. `SwapRequest` and the deposit-refund flow are the only request-then-approve patterns.

City Storage's rule, as stated on 11-17:
- **Staff request.**
- **Date change:** a manager approves (supervisor or admin).
- **Cancellation:** **super admin only** approves.

### 4.1 Generic `ChangeRequest`

**Model:**
`ChangeRequest { id, tenantId, bookingId, type: CANCEL | CHANGE_START_DATE, payload Json, reason, status: PENDING | APPROVED | REJECTED | WITHDRAWN, requestedBy, requestedAt, decidedBy, decidedAt, decisionNote }`

- At most one PENDING request per booking per type.
- Every transition is audited.

**Who may approve** comes from config, `Organization.approvalPolicy`. Defaults:
- `CANCEL` — ADMIN with organization scope (super admin).
- `CHANGE_START_DATE` — SUPERVISOR or ADMIN, any scope, who covers the branch.

**Requesting:**
- Any staff role in scope can request, from the booking page, the workbench card or the client page.
- The form takes a reason (required) and, for a date change, the new date.
- The decider cannot be the requester. This applies even to admins, as with the payment maker-checker.

**Console:**
- An **"Permintaan / Requests"** list with a pending count badge in the sidebar, for those who can approve.
- The booking page shows the pending request and its history.
- Replace the direct "Cancel booking" button with "Ajukan pembatalan / Request cancellation".
- A super admin can still cancel in one step: their request auto-approves itself, and the audit row records it.

### 4.2 Cancellation (what approval does)

Approval runs exactly what `/reject` does today:
- void unpaid invoices with the ledger reversal;
- release the unit;
- notify the customer;
- keep the 409 when money has moved.

**Cancelling after money has moved (P1).** If a payment SUCCEEDED, the request must say what happens to it: refund in full, keep the admin fee, or convert to credit. Approval then posts the matching ledger entries and creates a refund task. Until P1 lands, block it with a clear message: "Ada pembayaran — proses refund manual dulu".

### 4.3 Change check-in / start date

Allowed only before the rental is ACTIVE: statuses PENDING_APPROVAL, APPROVED, CONTRACT, or awaiting first payment.

On approval:
1. `startDate` moves, and the term end moves with it.
2. Unit availability is re-checked for the new window, including blackout. If the unit is not free, the request cannot be approved: the approver sees the conflict, and the requester can pick another unit.
3. The proforma and the payment schedule are regenerated:
   - unpaid scheduled and issued invoices are voided and re-issued with new periods and due dates;
   - numbers follow §6 of part 1.
4. If the contract has been generated, generate a new version. If the contract was already signed, it must be re-signed or re-confirmed; staff choose which.
5. Customer message: `booking_date_changed`, bilingual, carrying the new date.

**Acceptance:** with check-in moved from 20 Nov to 27 Nov on a 3-month term, the schedule periods start 27 Nov, the old proforma is VOID with the reason, and the new one carries the same amounts.

---

## 5. KYC and signing: online and offline (P0 unless marked)

The product was built online-first. City Storage also serves walk-in customers. The developer owes a written offline walkthrough (11-17 action item). This section is the spec for it.

### 5.1 Staff-assisted KYC (offline intake)

**Today:** `POST /kyc/documents` returns 403 unless the caller is a customer.

**Requirement:**
- Staff with `approve_booking` (or a new `upload_kyc_on_behalf` capability given to STAFF as well, see §12 Q6) can upload KYC files for a customer from the client page and the booking page. Allowed types: KTP, passport, selfie, NIB, NPWP, PPh support.
- Each upload records `uploadedByUserId` and `channel=STAFF`.
- After uploading, staff choose one of:
  - "Minta kekurangan via WhatsApp / Request what's missing". This sends `kyc_requested` listing only the missing document types, with the usual magic link.
  - "Verifikasi sekarang / Verify now", for an approver when everything is present.

**Acceptance:** staff upload a KTP for a walk-in, the customer receives a WhatsApp asking only for the selfie, and the KYC completes when the selfie arrives.

### 5.2 KYC requests as batches

**Today:**
- `request-kyc` only stamps `Booking.kycRequestedAt` and sends the message.
- Uploads are not linked to any request.
- The KYC page lists loose documents.

**Requirement:**
- New model `KycRequest { id, customerId, bookingId, requestedTypes[], requestedBy, requestedAt, channel, status: OPEN | COMPLETE | VERIFIED | REJECTED }`.
- Uploads attach to the open request.
- The KYC review page shows **one card per request (batch)**, containing:
  - who it is, and which booking it belongs to;
  - what was asked and when;
  - what has come back, as thumbnails with View;
  - what is still missing;
  - the PPh answer for companies;
  - Verify all, or Reject with a **required reason** that is sent to the customer.
- Add a history tab with verified and rejected requests, so a document can be found after review. Today it disappears from that page.

### 5.3 Two ways to sign

At the contract step, staff pick the method per booking, and the customer sees only that method.

**A. Online (default once Privy is live)**
- Integrate **Privy**, a certified e-signature service under the ITE law, through the existing adapter in `apps/agreements/providers/privy`.
- Flow:
  1. The magic link opens the contract page.
  2. "Tanda tangani di Privy" sends the customer to Privy with the document already loaded.
  3. The Privy webhook marks the contract signed and stores the signed PDF.
- Write the extra Privy login and account creation into the customer copy, so the extra step isn't a surprise.
- Blocked on the client creating the Privy account (11-17 action item). Until then, the online method uses the signature pad that exists today.
- **Fix before enabling any real provider:** the `/sign` upload path currently passes an uploaded scan to `esign.sendForSignature`. With Privy configured, a wet-signed scan would be sent out for e-signature. Make upload and e-sign separate code paths.

**B. Offline at the office**
- Staff print the generated contract (exists: "Open generated agreement").
- The customer signs on materai at the office.
- Staff scan and upload it. "Upload on behalf" exists on the booking page; add it to the client page as well.
- Add **a signing deadline**:
  - default 7 days from contract generation, set in `Tenant.featureFlags.offlineSignDays`;
  - reminders at 3 days and at 1 day before;
  - at expiry the booking goes to `LAPSED` through a worker job (the FSM transition exists; no job fires it today), and the unit is released.
- For company customers, the signatory field is required and should name the director. The company-stamp requirement is open (§12 Q3): add an optional "Stempel perusahaan ada / Company stamp present" checkbox on upload, recorded but not enforced.

**e-Meterai (P2):** only if City Storage asks. Privy offers it.

---

## 6. Users, roles and passwords (P0)

### 6.1 Passwords

Today there is no self-service change, no admin reset, and no forced change. During the 11-17 session, accounts were created live with simple, shared, spoken passwords.

**Requirements:**
- **Change my password:** a page in the user menu. Requires the current password. Minimum 10 characters, not equal to email or name, and not in a short common-password list.
- **Admin reset:** on Settings → Users, "Kirim tautan atur ulang / Send reset link".
  - It issues a single-use `UserPasswordToken`, valid 72 h. The mechanism already exists for imports.
  - Delivery is by email if configured, otherwise the link is shown to the admin to pass on.
  - Admins never see or set another user's password.
  - `POST /users` stops accepting a typed password and always issues a set-password link.
- **Force change:** add `User.mustChangePassword`. It is set on every account that was created with a typed password (backfill all current users) and on admin reset. Login then routes to the change page before anything else.
- **Session hygiene:** changing a password revokes the user's other sessions.

**Acceptance:** each account created on 11-17 is forced to pick a new password at next login.

### 6.2 Role matrix as City Storage described it

Matrix stated on 11-17, compared with code (`packages/domain/src/rbac/capability-matrix.ts`):

| Need (11-17) | Staff | Supervisor | Finance | Admin | Code today |
|---|---|---|---|---|---|
| Take orders, see invoices, deposits, contracts | ✔ | ✔ | ✔ | ✔ | matches |
| Request cancel / date change | ✔ | ✔ | — | ✔ | new (§4) |
| Approve date change | — | ✔ | — | ✔ | new |
| Approve cancellation | — | — | — | super admin | new |
| Finance section + reports | — | **no reports** | ✔ | ✔ | **SUPERVISOR has `run_reports` today** |
| Read and reply to WhatsApp | ✔ | ✔ | — | ✔ | matches |

**Changes:**
- Remove `run_reports` from SUPERVISOR. The developer told the client supervisors cannot see reports.
- Keep supervisor read access to invoices and deposits.
- Update `docs/RBAC.md`, the console mirror, and the denial tests.
- An organization-scoped SUPERVISOR (requested for one person on 11-17) sees all branches. The scope model already supports this; add a test for it.
- There is no "finance manager". FINANCE at organization scope is shown as "Super Finance", as today.

---

## 7. Test period, data and migration (P0)

### 7.1 Clean slate for client testing, then real cut-over

City Storage wants to test on an empty Kebon Jeruk: test renters with their own phone numbers, the real contract and invoice formats, no real customers. The `ONE_OFF_WIPE` tool exists. It is missing three things:

1. **Counter reset.** The wipe keeps the number counters, so test contracts and invoices consume real sequence numbers. Add `ONE_OFF_WIPE_RESET_COUNTERS=1`, which sets the document counters back to the legacy maximum. Run it at the **end** of testing, immediately before the final import, so real numbering continues from Booqable without gaps.
2. **Runbook.** Add this sequence to `RUNBOOK-GO-LIVE.md`, with who does each step:
   1. pause messaging
   2. wipe for testing
   3. turn on the test allowlist (§8.1)
   4. client tests
   5. pause
   6. wipe with counter reset
   7. final Booqable re-sync and import
   8. reconcile
   9. turn off the allowlist
   10. unpause
3. **Tell the client.** The console shows a banner on the branch during the test period: "Mode uji — data akan dihapus sebelum go-live / Test mode — data will be wiped before go-live".

Booqable re-sync stays manual. No automatic re-sync may run during the test period; the client asked for this explicitly.

### 7.2 Customer merge (P1)

**Today:** the importer refuses when a phone number already belongs to another RentOS customer. This happens when a person registered in RentOS and also exists in Booqable, which the 11-17 demo hit.

**Requirement:** add **Gabungkan pelanggan / Merge customers** on the client page, for org-scoped ADMIN.
- Pick the survivor and the duplicate.
- Move bookings, contracts, invoices, deposits, KYC documents, phones, legacy-record links and the message history to the survivor.
- Keep the survivor's customer number, and record the duplicate's number as an alias.
- Show a dry-run summary first, then audit the merge.

**Importer:** instead of erroring, list these cases as "possible duplicate — merge?" so they can be resolved in the console.

### 7.3 "Paid in Booqable" must be visible (P1)

**Today:**
- Booqable payments live only in the `/legacy` archive.
- Imported invoices settled in Booqable after import are VOIDed with a reason.
- Staff see "no payments yet" and are confused.

**Requirement:**
- Invoice and client pages show a **"Dibayar di Booqable / Paid in Booqable"** chip wherever a legacy payment or settlement exists for that invoice or rental, linking to the legacy record.
- The client page shows the rental's legacy *paid-through* date (already shown on the unit map) in the payments area.

---

## 8. WhatsApp during testing and go-live

### 8.1 Test allowlist (P0)

**Today:** pausing works, and resuming never replays the backlog. But during testing, resuming sends to **every** customer whose reminders fall due. Before the wipe, and after the re-import, those are real customers.

**Requirement:**
- `Organization.messagingAllowlist`: an array of E.164 numbers, plus a toggle "Hanya kirim ke nomor uji / Only send to test numbers".
- When the toggle is on, `outboundBlock()` suppresses every recipient not on the list, with reason `NOT_ON_TEST_ALLOWLIST`, and records the row as SUPPRESSED.
- The console banner shows "Mode uji: hanya N nomor" while the toggle is on.
- Settings → Messaging, org Admin only.

**Acceptance:** with the allowlist holding two numbers, approving bookings for three customers sends exactly two messages.

### 8.2 Suppressed messages are reviewable (P1)

There is a count in the banner but no page. Add a list showing:
- template
- recipient
- customer
- reason (`PAUSED` or `NOT_ON_TEST_ALLOWLIST`)
- created date

Filters by date and template, plus CSV export. Nothing in this list is ever re-sent automatically; this is already the behaviour and must stay.

### 8.3 Message wording review (P0, deliverable to the client)

The developer agreed to send every message text for City Storage to mark up.

- Add `pnpm wa:templates copy --format md`. It renders **every** `renderMessage` key in `packages/domain/src/comms/templates.ts`, in both languages, filled with realistic sample values, plus the auto-reply and the date-change and cancellation messages added here.
- Output one numbered list, `docs/COPY-whatsapp-messages.md`, with a blank "Perubahan / Change" line under each message.
- Their edits come back as a text diff applied to `templates.ts`. Add a test that no template contains "Gudang Aman", "RentOS" (customer-facing) or a placeholder left unfilled.
- Check the **database-stored** auto-reply text too: the copy saved on the demo organisation may still say Gudang Aman.

### 8.4 Pairing check (P0, ops)

The runbook says the system number is paired under the `gudang-aman` demo tenant (blocker B7). On 11-17 a phone was paired during the session.

- Verify which number is paired and under which organisation.
- Confirm that no demo organisation can send from City Storage's number.
- Record the result in `RUNBOOK-GO-LIVE.md`.

---

## 9. Console language and branding (P0 for language, P1 for branding)

### 9.1 Bahasa Indonesia console

City Storage's admins found the English labels confusing ("Legacy").

- Add i18n to `apps/console` (`next-intl` or equivalent) with `id` as default and `en` as an option, chosen per user in the user menu and stored on `User.locale`.
- Translate:
  - navigation
  - page titles
  - buttons
  - table headers
  - status chips (e.g. `PENDING_APPROVAL` → "Menunggu persetujuan")
  - empty states
  - confirmations
- Data values stay as entered.

**Naming changes:**

| Current | New |
|---|---|
| Legacy | Arsip Booqable |
| Approval Workbench | Persetujuan |
| Clients | Pelanggan |
| Reports | Laporan |
| Deposits | Deposit |
| Messages | Pesan |

The full key list lives in `apps/console/messages/id.json`, so City Storage can review it as a single file.

**Acceptance:** with locale `id`, no English UI string remains on the sidebar, reports, deposits, KYC, bookings, clients or settings pages. Check this with a test that greps for untranslated literals in those directories.

### 9.2 Branding

- "RentOS Console" is hardcoded in four places: `layout.tsx` (title), `ConsoleShell.tsx`, `login/page.tsx` and `set-password/page.tsx`.
- Read the product name and logo from the organisation instead: `Organization.branding.consoleName`, defaulting to "City Storage", plus the logo already stored on the tenant.
- The console URL moves to a City Storage domain (§12 Q8): set `CORS_ORIGINS`, the cookie domain and `STOREFRONT_BASE_URL` accordingly.

---

## 10. Carried over from part 1 (P1)

### 10.1 PPh withholding: net settlement (part 1 §8.3–8.4)

Display exists, hidden behind `pphWithholdingEnabled`. Settlement does not exist yet.

Build part 1 §8.4 as specified:
- `amount` and `pphWithheldAmount` on manual payment, plus a bukti potong upload;
- PAID when `amount + withheld = total`;
- an outstanding balance for short payments;
- ledger postings to `PREPAID_TAX_PPH`;
- a "Bukti potong belum diterima / Withholding slip outstanding" list.

The migration audit flagged 14 PPh customers. Enable display for them once finance validates the worked examples (§12 Q5).

### 10.2 RentalOrders console page (part 1 §13)

The API exists. Add a list and detail page in the same pattern as bookings.

### 10.3 T&C money rules (part 1 §14)

Each rule sits behind a per-branch flag, default off. The rules are: late fee, overstay fee, overtime charge, deposit refund task (now driven by `refundDueAt` from §3.1), and the "Akses ditolak" arrears badge.

---

## 11. Later (P2)

- XLSX exports
- Consolidated reporting across branches (Setiabudi is PKP and next)
- Read-only external API: payments endpoint, key scopes, rotation
- e-Meterai
- AI branch triage for unknown WhatsApp numbers

---

## 12. Decisions the client still owes (owner: Johnson)

1. **Cancellation after payment:** refund in full, keep the admin fee, or credit? Default: block until decided (§4.2).
2. **Who approves date changes:** supervisor and admin (the default), or admin only?
3. **Company stamp on contracts:** required or not? Default: optional checkbox (§5.3).
4. **PPN rate:** the session said "PPN 10%", the code uses 11%. What rate and label should Setiabudi's invoices carry? Finance to confirm with the tax adviser.
5. **PPh worked examples:** still owed from 11-05. They gate §10.1.
6. **Can STAFF upload KYC for walk-ins**, or only supervisors and admins? Default: staff can upload, only approvers verify.
7. **Offline signing deadline:** is 7 days right?
8. **Domains:** what URLs for the console and storefront (e.g. `admin.citystorage.co.id`, `sewa.citystorage.co.id`)?
9. **Privy account:** the client creates it (11-17 action item). We need sandbox credentials for §5.3.
10. **Open from part 1:** types for STORAGE-103 and STORAGE-105, the cut-over date, and Kebon Jeruk's CS WhatsApp number for auto-reply routing (runbook B1, B2 and B8).

## 13. Suggested build order

1. §2.1 range helper, §2.3 financial summary, §2.4 exports, §3 deposits (the twice-asked reporting set)
2. §2.2 sales report, §2.5 AR drill-down
3. §8.1 allowlist, §7.1 wipe counter reset and runbook. These unblock client testing; tell the client when they're in.
4. §6.1 passwords, §6.2 matrix
5. §4 change requests
6. §5.1–5.2 offline KYC and batches, §5.3 offline signing deadline
7. §9.1 Indonesian console, §8.3 copy deck sent to the client
8. P1 set: §7.2, §7.3, §8.2, §9.2, §10, then Privy once credentials exist
