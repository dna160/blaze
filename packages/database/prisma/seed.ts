/**
 * BUILD-SPEC v2.0 seed — City Storage.
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
  BookingModel,
  AssetStatus,
  BaseRole,
  RoleScope,
  CustomerType,
  MasterAgreementStatus,
  RentalOrderStatus,
} from "../generated/client/index.js";

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
  // C1 — the Organization (City Storage). Name is a placeholder until B8 confirms.
  const org = await prisma.organization.upsert({
    where: { slug: "city-storage" },
    update: {},
    create: {
      slug: "city-storage",
      name: "City Storage",
      legalName: "PT City Storage Indonesia",
      // #40 — org-level messaging config (one WA number for all branches). Empty
      // until the client's Meta business verification completes.
      messagingConfig: {},
    },
  });

  // C1 — Tenant = one branch/location. B8: one mockup branch for now.
  const tenant = await prisma.tenant.upsert({
    where: { slug: "city-storage-kebon-jeruk" },
    update: { organizationId: org.id },
    create: {
      organizationId: org.id,
      slug: "city-storage-kebon-jeruk",
      name: "City Storage — Kebon Jeruk (mockup)",
      legalName: "PT City Storage Indonesia",
      isPkp: true, // B4 — City Storage is PKP; invoices carry PPN.
      defaultLocale: "id",
      timezone: "Asia/Jakarta",
      branding: { primaryColor: "#0F172A", accentColor: "#F59E0B" },
      // C3 — monthly-only (allowSubMonthly off). #27 — bank transfer + card only.
      featureFlags: {
        deposits_enabled: true,
        kyc_required: true,
        auto_approve: false,
        contract_required: true,
        allowSubMonthly: false,
        paymentMethods: ["MANUAL_TRANSFER", "CARD"],
        // Phase 4 — gates GET /external/*, tenant API keys, and outbound
        // webhooks. On for the mockup branch so the console's API-access page
        // and the delivery worker are exercisable straight after a seed.
        api_access_enabled: true,
      },
    },
  });

  await prisma.tenantDomain.upsert({
    where: { domain: "kebon-jeruk.citystorage.local" },
    update: {},
    create: { tenantId: tenant.id, domain: "kebon-jeruk.citystorage.local", isPrimary: true },
  });

  // Location is now an optional descriptive row (C1).
  await prisma.location.upsert({
    where: { id: "00000000-0000-0000-0000-000000000101" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000101",
      tenantId: tenant.id,
      name: "Kebon Jeruk",
      address: "Jl. Kebon Jeruk Raya, Jakarta Barat",
      timezone: "Asia/Jakarta",
    },
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

  // Catalog — RECURRING_LEASE, monthly billing (C3).
  const unitSmall = await prisma.assetType.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: "unit-1-5x2" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Storage Unit 1.5×2m",
      slug: "unit-1-5x2",
      bookingModel: BookingModel.RECURRING_LEASE,
      attributesSchema: { sizeM2: 3, climateControlled: false },
      pricing: {
        basePrice: 450000,
        currency: "IDR",
        billingPeriod: "MONTHLY",
        // B5 — fixed nominal deposit.
        depositRule: { type: "FIXED", amount: 500000 },
        adminFee: 50000,
        taxInclusive: false,
        // #30/#31 — discount tiers (client's ~4.5/5/6% then hand-rounded).
        bundleTiers: [{ minUnits: 2, discountPct: 4.5 }, { minUnits: 3, discountPct: 5 }, { minUnits: 5, discountPct: 6 }],
        durationTiers: [{ minMonths: 6, discountPct: 5 }, { minMonths: 12, discountPct: 10 }, { minMonths: 24, discountPct: 15 }],
      },
      photos: [],
      isPublished: true,
    },
  });

  const unitMedium = await prisma.assetType.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: "unit-3x3" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Storage Unit 3×3m",
      slug: "unit-3x3",
      bookingModel: BookingModel.RECURRING_LEASE,
      attributesSchema: { sizeM2: 9, climateControlled: true },
      pricing: {
        basePrice: 1200000,
        currency: "IDR",
        billingPeriod: "MONTHLY",
        depositRule: { type: "FIXED", amount: 1200000 },
        adminFee: 75000,
        taxInclusive: false,
      },
      photos: [],
      // #16 — starts hidden; the client launches cautiously.
      isPublished: false,
    },
  });

  const assetSpecs = [
    { code: "A-01", assetTypeId: unitSmall.id, status: AssetStatus.AVAILABLE },
    { code: "A-02", assetTypeId: unitSmall.id, status: AssetStatus.OCCUPIED },
    { code: "A-03", assetTypeId: unitSmall.id, status: AssetStatus.MAINTENANCE },
    { code: "B-14", assetTypeId: unitMedium.id, status: AssetStatus.AVAILABLE },
    { code: "B-15", assetTypeId: unitMedium.id, status: AssetStatus.AVAILABLE },
  ];
  const assets = [];
  for (const a of assetSpecs) {
    assets.push(
      await prisma.asset.upsert({
        where: { tenantId_code: { tenantId: tenant.id, code: a.code } },
        update: {},
        create: {
          tenantId: tenant.id,
          locationId: "00000000-0000-0000-0000-000000000101",
          assetTypeId: a.assetTypeId,
          code: a.code,
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

  const occupied = assets.find((a) => a.code === "A-02");
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
      priceSnapshot: {
        basePrice: 450000,
        currency: "IDR",
        billingPeriod: "MONTHLY",
        depositRule: { type: "FIXED", amount: 500000 },
        adminFee: 50000,
        taxInclusive: false,
      },
    },
  });

  // eslint-disable-next-line no-console
  console.log(
    `Seeded org "${org.name}" with 1 branch (${tenant.slug}), 6 role×scope users, ` +
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
