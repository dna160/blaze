/**
 * BUILD-SPEC v2.0 seed — City Storage.
 *
 * Two modes (PRD go-live §4.1):
 *   SEED_MODE=production — bootstraps the organization and the Kebon Jeruk
 *     tenant from prisma/data/kebon-jeruk/ (city-storage.ts) and NOTHING else:
 *     no users, no customers, no units, no demo password. Staff come from the
 *     user CSV import; units from the unit CSV import; customers and rentals
 *     from the legacy migration.
 *   demo (default) — the same bootstrap plus everything below, for local dev
 *     and the staging database. Refuses to run when NODE_ENV=production unless
 *     SEED_MODE is set explicitly, so a production deploy cannot pick up the
 *     shared demo password by accident.
 *
 * Per blocking-decision B8 (location count not yet confirmed) this seeds ONE
 * mockup branch under one Organization, enough to render the console/storefront
 * and to demonstrate the renewed schema: C1 (Organization → Tenant=branch),
 * C2 (the six role × scope users), C4 (a RentalOrder against a signed
 * MasterAgreement). Add more branches here once B8 is answered.
 *
 * Runs as the migrator/owner role (DATABASE_URL, BYPASSRLS), so it does NOT go
 * through withTenantContext.
 *
 * Demo staff password for every seeded user (dev/demo ONLY — never a real
 * credential): "RentOS!Demo2026" (bcrypt cost 10 hash below).
 */
import {
  PrismaClient,
  AssetStatus,
  BaseRole,
  RoleScope,
  CustomerType,
  MasterAgreementStatus,
  RentalOrderStatus,
} from "../generated/client/index.js";

import { bootstrapCityStorage } from "./city-storage.js";

const prisma = new PrismaClient();
const DEMO_PASSWORD_HASH = "$2a$10$EvHMo0YpEy8LGcSzJL3DaOr26EZsqN/PuPBclcDWdyDU/b2eD1I.K";

interface RoleSpec {
  role: BaseRole;
  scope: RoleScope;
  tenantIds: string[];
}

async function seedStaffUser(
  tenantId: string,
  email: string,
  displayName: string,
  roleSpecs: RoleSpec[],
  passwordHash: string = DEMO_PASSWORD_HASH,
) {
  const user = await prisma.user.upsert({
    where: { tenantId_email: { tenantId, email } },
    update: { passwordHash },
    create: { tenantId, email, displayName, passwordHash, status: "ACTIVE" },
  });
  for (const spec of roleSpecs) {
    await prisma.userRole.upsert({
      where: { userId_role_scope: { userId: user.id, role: spec.role, scope: spec.scope } },
      update: { tenantIds: spec.tenantIds },
      create: { userId: user.id, role: spec.role, scope: spec.scope, tenantIds: spec.tenantIds },
    });
  }
  return user;
}

/**
 * The vendor platform-admin (Phase 4): the one User with `tenantId = null`.
 * That null IS the identity — CapabilityGuard treats a null-tenant staff session
 * as the vendor admin and bypasses the tenant capability matrix, and
 * PlatformAdminGuard admits nothing else. No UserRole row is created: BaseRole
 * describes what someone may do *inside* a tenant, which is exactly what this
 * user is outside of.
 *
 * Not seedStaffUser: that upserts on the `tenantId_email` composite unique, and
 * Postgres treats NULLs in a unique index as distinct, so an upsert keyed on a
 * null tenantId never matches an existing row and would insert a duplicate on
 * every re-seed. findFirst + create keeps it idempotent.
 */
async function seedPlatformAdmin() {
  const email = "platform-admin@rentos.test";
  const existing = await prisma.user.findFirst({ where: { tenantId: null, email } });
  if (existing) {
    return prisma.user.update({ where: { id: existing.id }, data: { passwordHash: DEMO_PASSWORD_HASH } });
  }
  return prisma.user.create({
    data: { tenantId: null, email, displayName: "RentOS Platform Admin", passwordHash: DEMO_PASSWORD_HASH, status: "ACTIVE" },
  });
}

async function main() {
  const mode = process.env.SEED_MODE ?? "demo";
  if (mode !== "production" && mode !== "demo") {
    throw new Error(`SEED_MODE must be "production" or "demo" (got "${mode}").`);
  }
  if (mode === "demo" && process.env.NODE_ENV === "production" && !process.env.SEED_MODE) {
    throw new Error(
      "Refusing to run the DEMO seed with NODE_ENV=production. Set SEED_MODE=production for a real deployment, " +
        "or SEED_MODE=demo explicitly for a staging database.",
    );
  }

  const { org, tenant, assetTypes, locationId } = await bootstrapCityStorage(prisma, { mode });

  if (mode === "production") {
    // eslint-disable-next-line no-console
    console.log(
      `Production bootstrap: org "${org.name}" (${org.legalName}), branch ${tenant.slug} [${tenant.branchCode}], ` +
        `${assetTypes.length} unit types, contract terms. Messaging is PAUSED. No users, customers or units were created — ` +
        `see docs/RUNBOOK-GO-LIVE.md for the user, unit and legacy imports.`,
    );
    return;
  }

  await prisma.tenantDomain.upsert({
    where: { domain: "kebon-jeruk.citystorage.local" },
    update: {},
    create: { tenantId: tenant.id, domain: "kebon-jeruk.citystorage.local", isPrimary: true },
  });

  // C2 — the six client roles as role × scope (docs/RBAC.md §2). ORGANIZATION-
  // scoped users still have a home tenant (their active branch) so they are NOT
  // treated as the vendor platform-admin (User.tenantId = null).
  await seedPlatformAdmin();

  await seedStaffUser(tenant.id, "superadmin@citystorage.test", "Super Admin (HO)", [
    { role: BaseRole.ADMIN, scope: RoleScope.ORGANIZATION, tenantIds: [] },
  ]);
  await seedStaffUser(tenant.id, "admin@citystorage.test", "Branch Admin", [
    { role: BaseRole.ADMIN, scope: RoleScope.TENANT, tenantIds: [tenant.id] },
  ]);
  await seedStaffUser(tenant.id, "superfinance@citystorage.test", "Super Finance (HO)", [
    { role: BaseRole.FINANCE, scope: RoleScope.ORGANIZATION, tenantIds: [] },
  ]);
  await seedStaffUser(tenant.id, "finance@citystorage.test", "Branch Finance", [
    { role: BaseRole.FINANCE, scope: RoleScope.TENANT, tenantIds: [tenant.id] },
  ]);
  // Dummy finance login for quick demo/testing — its OWN password (Finance123!),
  // distinct from the shared RentOS!Demo2026. Same dev-only caveat: never a real
  // credential. bcrypt(cost 10) hash of "Finance123!".
  await seedStaffUser(
    tenant.id,
    "finance@dummy.test",
    "Dummy Finance",
    [{ role: BaseRole.FINANCE, scope: RoleScope.TENANT, tenantIds: [tenant.id] }],
    "$2a$10$pgX057J4t1FJBYVPPwYG7Ozpi4YIfIbB55VnBgkvd14LUGzANVWxy",
  );
  await seedStaffUser(tenant.id, "spv@citystorage.test", "Supervisor", [
    { role: BaseRole.SUPERVISOR, scope: RoleScope.TENANT, tenantIds: [tenant.id] },
  ]);
  await seedStaffUser(tenant.id, "staff@citystorage.test", "Front Desk Staff", [
    { role: BaseRole.STAFF, scope: RoleScope.TENANT, tenantIds: [tenant.id] },
  ]);

  // Catalog — the seven real unit types come from the bootstrap. Demo units
  // reuse them with codes outside the real STORAGE-1..179 range so a later
  // unit import into staging never collides with them.
  const unitSmall = assetTypes.find((a) => a.slug === "small-storage")!;
  const unitMedium = assetTypes.find((a) => a.slug === "medium-storage")!;

  const assetSpecs = [
    { code: "DEMO-901", zone: "A", assetTypeId: unitSmall.id, status: AssetStatus.AVAILABLE },
    { code: "DEMO-902", zone: "A", assetTypeId: unitSmall.id, status: AssetStatus.OCCUPIED },
    { code: "DEMO-903", zone: "A", assetTypeId: unitSmall.id, status: AssetStatus.MAINTENANCE },
    { code: "DEMO-914", zone: "B", assetTypeId: unitMedium.id, status: AssetStatus.AVAILABLE },
    { code: "DEMO-915", zone: "B", assetTypeId: unitMedium.id, status: AssetStatus.AVAILABLE },
  ];
  const assets = [];
  for (const a of assetSpecs) {
    assets.push(
      await prisma.asset.upsert({
        where: { tenantId_code: { tenantId: tenant.id, code: a.code } },
        update: {},
        create: {
          tenantId: tenant.id,
          locationId,
          assetTypeId: a.assetTypeId,
          code: a.code,
          zone: a.zone,
          status: a.status,
        },
      }),
    );
  }

  // A demo customer with a signed master agreement + one active rental order
  // (C4/§5) so the console has a live order to render.
  const customer = await prisma.customer.upsert({
    where: { tenantId_phone: { tenantId: tenant.id, phone: "+6281100000001" } },
    update: {},
    create: {
      tenantId: tenant.id,
      type: CustomerType.INDIVIDUAL,
      phone: "+6281100000001",
      email: "budi@example.test",
      fullName: "Budi Santoso",
      kycStatus: "VERIFIED",
    },
  });

  const master = await prisma.masterAgreement.upsert({
    where: { id: "00000000-0000-0000-0000-000000000201" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000201",
      tenantId: tenant.id,
      organizationId: org.id,
      customerId: customer.id,
      templateVersion: "v1",
      status: MasterAgreementStatus.SIGNED,
      signedAt: new Date("2026-07-01T00:00:00Z"),
      signedByName: "Budi Santoso",
      esignProvider: "MOCK",
    },
  });

  const occupied = assets.find((a) => a.code === "DEMO-902");
  await prisma.rentalOrder.upsert({
    where: { id: "00000000-0000-0000-0000-000000000301" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000301",
      tenantId: tenant.id,
      masterAgreementId: master.id,
      customerId: customer.id,
      assetTypeId: unitSmall.id,
      assetId: occupied?.id,
      status: RentalOrderStatus.ACTIVE,
      periodStart: new Date("2026-08-01T00:00:00Z"),
      periodEnd: new Date("2026-09-01T00:00:00Z"),
      priceSnapshot: unitSmall.pricing as object,
    },
  });

  // eslint-disable-next-line no-console
  console.log(
    `Seeded DEMO org "${org.name}" with 1 branch (${tenant.slug}), 6 role×scope users, ` +
      `${assets.length} assets, 1 signed master agreement, 1 active rental order, ` +
      `and the vendor platform admin.`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
