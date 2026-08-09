# RentOS — Backup & Restore Runbook

**Precedence:** authoritative for backup/restore. Implements `docs/BUILD-SPEC.md`
delta-register item **#50** and its Gate R3 requirement. Item #51 (Railway security
assurance brief) is a related but separate deliverable.

> **#50 is the item the client asked about directly and received no answer.** This
> runbook is that answer. It is a *plan of record* — the scripts under `infra/backup/`
> and the `backup-verify.job.ts` worker job are R3 deliverables and do not exist yet.
> A backup strategy that has never restored is not a backup; see §5.

---

## 1. What must be protected

| Asset | Store | Backup mechanism |
|---|---|---|
| Postgres (all business data, ledger, PII) | Railway Postgres | PITR + nightly logical dump (§2) |
| Uploaded files (KTP/selfie images, payment proofs, signed PDFs) | Object storage (`S3StorageProvider`) | Bucket versioning + lifecycle (§3) |
| Redis (BullMQ queues) | Railway Redis | **Not backed up by design** — transient job state; jobs are idempotent and re-derive from Postgres (§4) |
| Application code + migrations | GitHub (`dna160/blaze`) | Git is the backup; migrations are the schema's source of truth |

> PII note: KTP/selfie images are real PII (`docs/HANDOFF.md` — PII encrypted at
> rest). `LocalDiskStorageProvider` is dev-only and its container filesystem is
> ephemeral; production **must** run `STORAGE_PROVIDER=s3` (or a mounted Railway
> Volume) before this runbook's file-backup guarantees mean anything.

## 2. Postgres — two independent layers

1. **Point-in-time recovery (PITR).** Railway Postgres retains WAL for continuous
   recovery. This is the low-RPO layer: recover to any moment within the retention
   window. Confirm and record the actual retention window Railway provides for the
   plan in use — do not assume.

2. **Nightly logical dump to object storage.** A `pg_dump` (custom format,
   compressed) written nightly to a **separate** object-storage bucket, ideally a
   different provider/region than Railway, so a Railway-account-level failure does
   not take the backups with it. Retention: 30 daily + 12 monthly (tune to the
   client's compliance answer). This is the independent, portable layer that does not
   depend on Railway's own tooling.

Why both: PITR gives tight RPO but lives inside Railway; the logical dump is
portable and survives provider-level loss. Neither alone is sufficient.

## 3. Uploaded files

- Enable **object-versioning** on the storage bucket so overwrites/deletes are
  recoverable.
- Lifecycle policy to expire noncurrent versions after the retention window.
- The nightly verify job (§5) samples a known object and asserts it is readable.

## 4. Redis is intentionally not backed up

BullMQ queue state is transient. Every job is designed to be idempotent and to
re-derive its work from Postgres (recurring-invoice generation, dunning, ledger
balance-check, etc.). On Redis loss, jobs re-enqueue from source-of-truth Postgres
state on the next scheduled run. Backing up Redis would protect nothing that
Postgres does not already hold. This is a deliberate decision, recorded here so a
future session does not mistake it for a gap.

## 5. Restore drill — the part that makes it real

**A backup that has never been restored is not a backup.** Gate R3 requires a backup
restored into a scratch database and queried. Automate the assertion:

- `apps/worker/src/jobs/backup-verify.job.ts` (R3, `[+]`) runs nightly: takes the
  latest logical dump, restores it into a throwaway scratch database, runs a small
  set of assertions, then drops the scratch DB.
- Minimum assertions:
  - Restore completes without error.
  - Row counts for core tables (`invoices`, `payments`, `ledger_entries`,
    `customers`, `bookings`) are non-zero and within a sane delta of production.
  - **The ledger balances on the restored copy:**
    `SELECT entry_type, sum(amount) FROM ledger_entries GROUP BY entry_type`
    returns identical DEBIT/CREDIT totals — the same invariant the whole codebase is
    held to (`docs/HANDOFF.md`, §11.3 of the spec).
  - A sampled uploaded object is readable from storage.
- On any failure, alert loudly — a silent restore failure is the exact trap this job
  exists to prevent.

Additionally, run a **manual** full restore drill at least once per quarter and
before every launch/cutover, and record it in the log at the bottom of this file.

## 6. RTO / RPO targets

Proposed targets — **confirm with the client** against their tolerance and Railway's
actual PITR retention:

| Metric | Target | Basis |
|---|---|---|
| **RPO** (max data loss) | ≤ 5 minutes | Postgres PITR / WAL |
| **RPO** (provider-loss fallback) | ≤ 24 hours | nightly logical dump |
| **RTO** (restore to service) | ≤ 4 hours | logical restore + service redeploy, rehearsed |

These are meaningless until proven by a rehearsed drill (§5). Record actual measured
restore time in the drill log and revise the RTO to the truth.

## 7. Related: Railway security brief (#51)

The client said they would verify Railway's security independently. Prepare a
one-page brief (separate deliverable, R3) covering: data residency/region, encryption
at rest and in transit, access controls on the Railway project, the two-connection-
string RLS model (`rentos_app` non-owner role, `FORCE ROW LEVEL SECURITY`; see
`docs/HANDOFF.md`), and this backup/restore posture. Keep it to one page and free of
secrets.

---

## 8. Restore-drill log

Record every drill (automated failures worth noting, and every manual drill) here.

| Date | Type (auto/manual) | Source backup | Restore time | Ledger balanced? | Result | Run by |
|---|---|---|---|---|---|---|
| _pending_ | _—_ | _—_ | _—_ | _—_ | _—_ | _—_ |
