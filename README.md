# RentOS

Multi-tenant rental operations platform. Storefront + admin console for
asset-rental businesses ("asset × time"), launching with a self-storage
tenant in Indonesia. Full product spec: [`docs/PRD.md`](./docs/PRD.md).
Current build status, architectural decisions, and what's not done yet:
[`docs/HANDOFF.md`](./docs/HANDOFF.md) — **read that before extending this
codebase.**

## What the storage tenant's flow looks like (PRD v2)

Spec: [`docs/PRD-v2-storage-flow.md`](./docs/PRD-v2-storage-flow.md).

```
Storefront   choose branch (map, closest first) → choose size (S/M/L) → check-in date + 1/3/6/12-month term + name + WhatsApp
             → "confirmation soon" (approval pipeline)  |  full → WAITLISTED (position shown, staff offer a unit later)
Console      Approval → Request KYC (magic link, no OTP) → Generate contract + proforma (PDFs, monthly payment schedule) → Finance (pay → ACTIVE)
Worker       issues each scheduled month H-7, ends terms on their end date, expires stale requests; dunning unchanged
Finance      AR aging as of any date with a 30/60/90-day horizon; client list with healthy / risky / overdue / inactive
```

Availability is a date-range query with a **blackout month** after every lease (the deposit-covered month) — `Asset.status` is only the floor view. Homestay/equipment tenants (NIGHTLY / DURATION_ORDER) are untouched by all of this.

## Architecture

Modular monolith (PRD §11): one API, hard module boundaries, no
microservices for a single tenant. Multi-tenant from commit #1 — every
tenant-owned table carries `tenant_id` and is protected by Postgres
Row-Level Security, enforced by a dedicated non-owner DB role
(`rentos_app`), not application convention. See
[`docs/HANDOFF.md`](./docs/HANDOFF.md) for why that distinction matters.

```
rentos/
├── apps/
│   ├── api/            NestJS modular monolith — tenancy, auth, catalog,
│   │                    booking, finance, payments, notifications, crm,
│   │                    reporting, audit modules (apps/api/src/*)
│   ├── worker/          BullMQ processors — recurring invoice generation,
│   │                    dunning ladder (apps/worker/src/jobs/*)
│   ├── storefront/       Next.js — public catalog, booking flow, OTP auth,
│   │                    customer portal
│   └── console/           Next.js — staff login, approval workbench,
│                          inventory, invoices, reports
├── packages/
│   ├── database/        Prisma schema (PRD Appendix A), RLS migrations,
│   │                    seed script, shared invoicing orchestration
│   ├── domain/            Pure business logic — BookingModelStrategy
│   │                    (the pluggable core, PRD §5.2), state machines,
│   │                    proration/tax/deposit math. Zero framework deps,
│   │                    fully unit-tested (33 tests)
│   ├── contracts/          Shared zod schemas/DTOs — one source of truth
│   │                    for validation (API) and types (frontends)
│   └── config/              Shared tsconfig/eslint presets
├── infra/docker/              Dockerfile per service (Docker builder,
│                             not Nixpacks — see each Dockerfile's header)
├── docker-compose.yml           Local dev: builds the same Dockerfiles
│                                Railway will build, + Postgres + Redis
└── apps/*/railway.toml            Per-service Railway config
```

## The extensibility thesis (PRD §5.2)

Every `AssetType` declares one `BookingModel` (`RECURRING_LEASE`,
`NIGHTLY`, `DURATION_ORDER`, `HOURLY_SLOT`). All calendar math, billing
cadence, and lifecycle verbs live behind `BookingModelStrategy`
(`packages/domain/src/booking-model/`) — nothing outside that package is
allowed to branch on "is this storage?". `RECURRING_LEASE` (storage, the
launch vertical) is fully implemented and tested. The other three are
typed stubs that satisfy the same interface and throw
`BookingModelNotImplementedError` — proving the seam exists without
pretending Phase 3 vertical math is done.

## Local development

Requires Node 22+, pnpm (via corepack), and either Docker or local
Postgres 16 + Redis.

```bash
corepack enable && corepack prepare pnpm@9.15.0 --activate
pnpm install

# Postgres + Redis: either `docker compose up postgres redis` or point
# DATABASE_URL at your own local instance.

cp .env.example .env   # fill in DATABASE_URL, DATABASE_URL_APP, REDIS_URL, JWT_SECRET

pnpm --filter @rentos/database migrate:deploy   # applies schema + enables RLS
pnpm --filter @rentos/database seed             # seeds the demo storage tenant

pnpm dev   # runs api (:4000), worker, storefront (:3000), console (:3001) in parallel
```

Default local tenant: `gudang-aman` (seeded storage operator demo data —
see `packages/database/prisma/seed.ts`). `NEXT_PUBLIC_DEV_TENANT_SLUG` /
`NEXT_PUBLIC_TENANT_SLUG` point the frontends at it without needing
wildcard DNS.

### Full Docker stack

```bash
docker compose up --build
```

Builds and runs all 4 services + Postgres + Redis using the exact
Dockerfiles Railway will build from. **This was not verified in the
sandbox this codebase was built in** (Docker Hub registry access was
policy-blocked there) — validate it in your own environment before
trusting it. See `docs/HANDOFF.md` for details.

### Tests

```bash
pnpm test   # 122 unit tests in packages/domain (state machines, term schedule, blackout overlap, proration, tax, AR aging, client health)
scripts/smoke-v2.sh   # end-to-end HTTP smoke test of the PRD v2 flow against a running local API + seeded gudang-aman (needs DATABASE_URL for the psql checks)
```

### Sandboxes that can't download Prisma engines

If `prisma generate` fails fetching from `binaries.prisma.sh`, the repo can still run end to end:
`scripts/migrate-deploy-psql.sh` applies migrations with plain `psql` (recording them exactly like
`prisma migrate deploy` would), and `PRISMA_DRIVER_ADAPTER=pg` + `NODE_OPTIONS="--import
$PWD/scripts/prisma-wasm-loader.mjs"` switch the runtime to Prisma's bundled WASM engine via the
`pg` driver adapter. Set `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1` and point
`PRISMA_SCHEMA_ENGINE_BINARY` / `PRISMA_QUERY_ENGINE_LIBRARY` at any placeholder file so
`prisma generate` skips the download. None of this applies to a normal deployment.

## Deploying to Railway

No Nixpacks anywhere — every service builds from its Dockerfile
(`infra/docker/*.Dockerfile`) via `builder = "DOCKERFILE"` in its
`railway.toml`. Full dashboard walkthrough (Postgres/Redis plugins, the
`rentos_app` RLS role, per-service env vars, migration step) is in
[`docs/HANDOFF.md`](./docs/HANDOFF.md#railway-deployment--dashboard-steps-no-cli-login-available-this-session).

Quick version: one Railway project, Postgres + Redis plugins, four
services from this repo each pointed (via **Config File Path** in the
dashboard) at `apps/api/railway.toml`, `apps/worker/railway.toml`,
`apps/storefront/railway.toml`, `apps/console/railway.toml`.

## Multi-tenancy: how a request finds its tenant

- `apps/api` resolves tenant from `X-Tenant-Slug` (forwarded by the
  frontend BFFs) or the request `Host` (real subdomain/custom domain),
  falling back in that order.
- Every *mutating* endpoint requires a JWT; `TenantMatchGuard` rejects any
  request where the session's tenant disagrees with the resolved tenant —
  so the header/Host resolution can only ever affect which tenant's
  *public* catalog an anonymous request browses, never a write.
- Every DB query goes through `withTenantContext()`
  (`packages/database/src/tenant-context.ts`), which sets the Postgres
  session variable RLS policies check. There is no `where: { tenantId }`
  escape hatch anywhere in the codebase — forgetting tenant scope is
  structurally a zero-rows result, never a cross-tenant leak.

## License

UNLICENSED — internal tool (PRD §1: "internal tool first; architecture
must not preclude future SaaS").
