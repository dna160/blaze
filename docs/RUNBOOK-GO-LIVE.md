# RentOS — Kebon Jeruk go-live runbook

**Scope:** taking City Storage Kebon Jeruk live on real data, retiring Booqable for
this branch. Spec: [`PRD-kebon-jeruk-go-live.md`](./PRD-kebon-jeruk-go-live.md).
Data pack: [`packages/database/prisma/data/kebon-jeruk/`](../packages/database/prisma/data/kebon-jeruk/).
Backups: [`RUNBOOK-BACKUP.md`](./RUNBOOK-BACKUP.md).

Secrets are referenced **by name only**. Values live in Railway, never in git or chat.

---

## 0. Blockers (cannot go live until these are answered)

| # | What | Owner | Where it lands |
|---|---|---|---|
| B1 | **Unit type per unit.** Done for 170 of 172 from Booqable's rental history (2026-11-10, `scripts/booqable/unit_types.py`); **STORAGE-103 and STORAGE-105** were never rented and still need a type. | Client (§16 Q5) | `unit_type_slug` column, then step 5 |
| B2 | **Booqable data.** Pulled through the API on 2026-11-10 (`scripts/booqable/fetch.py`, `to_migration.py`) and rehearsed clean: 86 customers, 188 unit rentals, 48 open invoices. Still owed: the cut-over date, and the branch's confirmation of the deposits actually held (Booqable records a deposit for only 17 of the 188 rentals). | Client (§16 Q4) | step 7 |
| B3 | **Staff list** (email, name, role, scope, branch). | Client | `go-live-users.csv`, step 4 |
| B4 | **Numbering**: keep `KBJ-` in front, or continue exactly as Booqable (`5-2026-36-39`)? | Client (§16 Q1) | Settings → Branch → numbering |
| B5 | **PKP**: does Kebon Jeruk charge PPN from go-live? Seeded `isPkp=false`. | Finance (§16 Q2) | Settings → Branch |
| B6 | **Storefront domain** (e.g. `sewa.citystorage.co.id`). | Client (§16 Q9) | `tenant_domains`, step 9 |
| B8 | **Kebon Jeruk's CS contact as shown on the website** (WhatsApp, and confirm phone 021-300 67838 / `cs@citystorage.co.id`). The data pack's WhatsApp, +62 811-1877-838, is the system number, so the branch has no CS WhatsApp until this is entered. | Client | Settings → Branch → contacts |
| B7 | **The phone that owns the City Storage system number**, to re-pair it under production (it is paired under the `gudang-aman` demo tenant today). | Client | step 6 |

Open but not blocking: Free Style pooled vs fixed units (Q3 — the three Free Style
types are seeded **unpublished**), zone of unit 38 and units 92–100 (Q5), inbox access
for Finance (Q6), T&C money rules (Q7), invoice due-date rule (Q8), finance's worked
PPN/PPh examples (Q10 — PPh withholding display stays off until then).

---

## 1. Two databases

| | Staging | Production |
|---|---|---|
| Database | the **current** Railway Postgres | a **new** Railway Postgres |
| Seed | `pnpm db:seed` (demo: demo users, demo units `DEMO-9xx`, mock payments on) | `pnpm db:seed:production` — org + Kebon Jeruk tenant + 7 unit types + T&C v1, **no users, customers, units or demo passwords**, messaging **paused** |
| Purpose | demos, training, import rehearsals | real customers only |

Do **not** purge demo rows from the current database instead (PRD §4.1): RLS and
append-only ledger rows make partial deletes risky; a fresh database is cheap.

The demo seed refuses to run with `NODE_ENV=production` unless `SEED_MODE` is set
explicitly.

---

## 2. Environment checklist (production)

### apps/api

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | |
| `DATABASE_URL` | Railway Postgres reference (owner) | migrations, seed, CLIs only |
| `DATABASE_URL_APP` | `rentos_app` connection string | **change the role password** from the migration default first (`ALTER ROLE rentos_app WITH PASSWORD …`) |
| `REDIS_URL` | Railway Redis reference | |
| `JWT_SECRET` | secret `JWT_SECRET` (32+ random bytes) | |
| `CORS_ORIGINS` | the storefront and console origins, comma-separated | |
| `PAYMENT_PROVIDER` | **unset** until the client's Xendit account exists, then `xendit` | Without `xendit`, production disables online payment for every branch (§4.3): Pay is hidden, `POST /payments/initiate` answers 409, only manual record + verify settles an invoice. |
| `XENDIT_SECRET_KEY`, `XENDIT_WEBHOOK_TOKEN` | secrets of the same names | client creates the account (§4.3) |
| `MESSAGING_PROVIDER` | `whatsapp_linked` | the org can also choose it in Settings → Messaging |
| `WA_BRIDGE_URL` | bridge private URL | |
| `WA_BRIDGE_TOKEN` | secret `WA_BRIDGE_TOKEN` (same on api, worker, wa-bridge) | |
| `MESSAGING_CONFIG_KEY` | secret `MESSAGING_CONFIG_KEY` (64 hex) | only needed for WhatsApp Cloud tokens |
| `EMAIL_PROVIDER` / `RESEND_API_KEY` / `EMAIL_FROM` | `resend` + secret | set-password emails; without it, admins hand links over from the import screen |
| `STOREFRONT_BASE_URL` | `https://<storefront domain>` | magic links, invoice portal links |
| `CONSOLE_BASE_URL` | `https://<console domain>` | staff set-password links |
| `STORAGE_PROVIDER` | **`s3`** | KYC documents, signatures and signed contracts must not sit on ephemeral disk |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | secrets of the same names | bucket versioning per RUNBOOK-BACKUP §3 |
| `ESIGN_PROVIDER` | `mock` | stays until the Privy/Mekari decision (§7.2); the portal signature pad works without it |
| `DEV_OTP_BYPASS_CODE` | **unset** | |

### apps/worker
`DATABASE_URL_APP`, `REDIS_URL`, `MESSAGING_PROVIDER`, `WA_BRIDGE_URL`, `WA_BRIDGE_TOKEN`,
`EMAIL_PROVIDER` (+ Resend secrets), `STOREFRONT_BASE_URL`, `MESSAGING_CONFIG_KEY`.

### apps/wa-bridge
`WA_BRIDGE_TOKEN`, `WA_BRIDGE_DATABASE_URL` (owner role), `WA_BRIDGE_WEBHOOK_URL`
(`https://<api>/api/notifications/wa-bridge/webhook`), `WA_BRIDGE_MIN_GAP_MS=3000`,
`WA_BRIDGE_DAILY_CAP=1000`, `WA_BRIDGE_TZ=Asia/Jakarta`. The daily count now lives in
`wa.daily_send_counts` and survives restarts. One bridge per environment: the
production bridge stores its sessions in the production database and calls back the
production API (step 6 — the City Storage number moves there).

### apps/storefront (build-time)
`NEXT_PUBLIC_API_URL`. **Remove `NEXT_PUBLIC_DEV_TENANT_SLUG`** once the domain is
mapped (step 9). Until then set it explicitly to `city-storage-kebon-jeruk` — never
`gudang-aman`. It is compiled in: changing it needs a rebuild.

### apps/console (build-time)
`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_TENANT_SLUG=city-storage-kebon-jeruk`.

---

## 3. Bootstrap production

```bash
pnpm db:migrate
```

```bash
pnpm db:seed:production
```

Expected: `Production bootstrap: org "City Storage" (PT Servis Storej Indonesia), branch
city-storage-kebon-jeruk [KBJ], 7 unit types, contract terms. Messaging is PAUSED.`

Acceptance (§4.1):

```sql
select slug from tenants;                                   -- only City Storage branches
select count(*) from users where email like '%.test';       -- 0
select messaging_paused from organizations;                 -- true
```

## 4. Staff accounts

Fill `go-live-users.csv` (email, display_name, role, scope, branch_slug). The first
Super Admin can only come from the CLI — production has no users:

```bash
CONSOLE_BASE_URL=https://<console> pnpm import:users --org city-storage --file go-live-users.csv
```

```bash
CONSOLE_BASE_URL=https://<console> pnpm import:users --org city-storage --file go-live-users.csv --apply
```

It prints one single-use set-password link per new account (72 hours). Hand each to
its owner only. Later additions: Console → Settings → Users → Import CSV (same file
format; links are emailed and also shown to the admin). Nobody ever has a shared or
default password.

## 5. Branch profile and units

1. Log in as the Super Admin. **Settings → Branch**: check legal entity, address, CS
   contacts, BCA account, hours, `isPkp` (B5), numbering (B4). Every change is audited.
2. Units (needs B1):

```bash
pnpm import:units --tenant city-storage-kebon-jeruk --file kebon-jeruk-units.csv
```

   Dry run lists per-row errors and the units RentOS has that the file does not.
   Re-run with `--apply` when it reports zero errors (or use Console → Inventory →
   Import units). It never deletes.

## 6. Messaging — the City Storage system number

**+62 811-1877-838 is City Storage's system number** (owner, 2026-11-09): every
customer message, for every branch, is sent from it (contracts, invoices, sign-in
links, reminders, auto-replies; PRD go-live §9). It is **not** a CS contact — the
branches' CS contacts on the website are different numbers. RentOS stores it as the
organization's system number (Settings → Messaging; seeded from the data pack),
refuses it as a branch CS WhatsApp in Settings → Branch, and the auto-reply never
points customers back to it.

It is currently paired under the `gudang-aman` demo tenant. Two consequences:

- **Today, demo traffic goes out from City Storage's real number.** Anything the demo
  tenant triggers on the current database (approvals, dunning, sign-in links,
  auto-replies) reaches real WhatsApp users from it, and cold-messaging the seeded
  fake numbers is how a linked number gets banned. Until the move below, keep the
  demo organization paused: log in as a Gudang Aman org admin → Settings →
  Messaging → **Pause messaging**.
- **The pairing does not follow the data.** The linked device is keyed by
  organization id in the bridge's `wa` schema (`wa.rentos_instances`), so the new
  production City Storage organization starts unpaired. Move it by re-pairing:

1. Production gets **its own** wa-bridge service: `WA_BRIDGE_DATABASE_URL` = the
   production database, `WA_BRIDGE_WEBHOOK_URL` = the production API. Staging keeps
   `MESSAGING_PROVIDER=console_log` and no bridge variables from then on.
2. Production console, as the Super Admin → Settings → Messaging → linked device →
   enter the system number → **Get pairing code**. On the phone that owns the number:
   WhatsApp → Linked devices → Link a device → *Link with phone number instead* →
   type the code. The state moves to *connected*; send a test message to a staff phone.
3. Staging console (Gudang Aman org admin) → Settings → Messaging → **Unlink**, so the
   old linked device is logged out. Check on the phone (Linked devices) that only the
   production link remains.
4. Re-enter the auto-reply text and cooldown in production — they were saved on the
   demo organization and do not carry over.

Customers who reply to the system number get the auto-reply, which points them to
their branch's CS: use `{branchContact}` (CS WhatsApp, else phone, else email), as in
`DEFAULT_AUTO_REPLY_TEXT`. Until Kebon Jeruk's CS WhatsApp is entered (B8) it falls
back to the CS phone.

Pair the admin WhatsApp number in Settings → Messaging (org-scoped Admin only). Set the
auto-reply text, e.g. the default in `@rentos/domain` `DEFAULT_AUTO_REPLY_TEXT`, using
`{branchName}` `{branchWhatsapp}` `{branchPhone}` `{allBranches}`; it fires at most once
per number per cooldown (default 12 h) and not after a human reply. **Leave messaging
paused** until step 8.

## 7. Migration from Booqable (needs B2)

The data comes straight from Booqable's API (key in the environment only, never in
git; the output holds customer PII, so keep it out of the repo):

```bash
BOOQABLE_API_KEY=<key> python3 scripts/booqable/fetch.py ./booqable
```

```bash
python3 scripts/booqable/to_migration.py ./booqable packages/database/prisma/data/kebon-jeruk/kebon-jeruk-units.csv ./import
```

On a **re-sync** (anything after the first import), pass the rentals file that
was applied last time as a fifth argument, so each rental keeps the key it was
imported under, and run the migration with `--reconcile` so invoices settled
in Booqable since are closed here:

```bash
python3 scripts/booqable/to_migration.py ./booqable packages/database/prisma/data/kebon-jeruk/kebon-jeruk-units.csv ./import 2026-11-12 ./previous/migration-rentals.csv
```

The history (every order, invoice, payment, contract with its signature, note
and setting, kept as Booqable made them) goes into the read-only legacy archive:

```bash
python3 scripts/booqable/to_archive.py ./booqable ./archive
```

Each `archive-NNN.json` is posted to `POST /api/legacy/records/import` as an
org-scoped Admin (idempotent). Console → Legacy Records shows the result.

That writes the three migration CSVs, `units-full.csv` (the 172 STORAGE units plus
Booqable's 6 X-Large and 20 Freestyle stock items) and `REVIEW-*.csv` lists for staff
(unpaid invoices on ended rentals, unfinalized drafts). Import `units-full.csv` in
step 5, then continue below. Regenerate the key in Booqable once the migration is done.

Put the three CSVs (templates in the data pack) and the signed contract PDFs in one
folder. Rehearse on a **staging copy of production** first:

```bash
pnpm migrate:legacy --tenant city-storage-kebon-jeruk --dir ./import --min-contract-seq <max Booqable contract #> --min-invoice-seq <max Booqable invoice #>
```

The dry run prints what it would create, every error and warning, and the totals to
reconcile against Booqable: **active rentals, monthly rent, AR outstanding, deposits
held**. It refuses unless messaging is paused. Apply with `--apply` (refused unless the
dry run is clean). It is idempotent — re-running updates, never duplicates.

What it does: customers keep their Booqable numbers (KYC `VERIFIED_LEGACY`); contracts
and invoices keep their numbers; rentals become ACTIVE with the unit OCCUPIED and the
deposit HELD at the amount actually held; the next invoice is the first cycle after
`paid_through` (no back-invoicing); the ledger gets opening balances only. New numbers
continue above the highest legacy one.

## 8. Cut-over (§10.2)

1. Messaging is paused (banner on every console page).
2. Import into a staging copy of production; reconcile the totals with Booqable.
3. Import into production.
4. Spot-check 10 customers with the branch: client page documents, contract #,
   unit, deposit, next due date.
5. Freeze Booqable.
6. Review the **SUPPRESSED** notifications (everything that would have gone out while
   paused) and confirm none should be sent; then unpause in Settings → Messaging.

## 9. Storefront domain (needs B6)

```sql
insert into tenant_domains (id, tenant_id, domain, is_primary)
select gen_random_uuid(), id, 'sewa.citystorage.co.id', true from tenants where slug = 'city-storage-kebon-jeruk';
```

Point DNS at the storefront service, then rebuild the storefront **without**
`NEXT_PUBLIC_DEV_TENANT_SLUG`. Acceptance: the storefront root shows City Storage
Kebon Jeruk. Set the branch's map pin (Console → Catalog setup → Locations) — the data pack
leaves coordinates to be filled from Google Maps.

## 10. Payments

Until Xendit is live the portal shows the bank transfer details from Settings →
Branch and a "send proof to WhatsApp CS" button. Staff record the transfer
(`record_payment`) and a **different** person verifies it (`verify_payment`). When the
client's Xendit account exists: set `PAYMENT_PROVIDER=xendit` + keys, redeploy, then
switch **Online payment** on in Settings → Branch.

## 11. Backups

Before go-live, run one backup and one test restore per
[`RUNBOOK-BACKUP.md`](./RUNBOOK-BACKUP.md) §8 against the production database, and
record the drill.

## 12. Go-live acceptance (PRD §1)

- [ ] Production has only real data: one organization, City Storage tenants, no `.test` users.
- [ ] No message can reach a customer unintentionally: messaging was paused through the import; SUPPRESSED queue reviewed.
- [ ] A contract and an invoice for a migrated customer show City Storage's format: number, PT Servis Storej Indonesia, BCA account, T&C.
- [ ] With no Xendit keys, nothing can produce a SUCCEEDED payment except manual record + verify.
