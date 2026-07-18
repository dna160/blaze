/**
 * Seeds two tenants in two different verticals — proving PRD §5.2's
 * extensibility thesis in the one place a fresh environment can see it
 * without touching application code: tenant #1 is a self-storage operator
 * (RECURRING_LEASE), tenant #2 is a homestay operator (NIGHTLY, Session
 * 16). Each gets demo AssetTypes, Assets, staff logins, a customer, and
 * one booking already mid-lifecycle so the storefront/console have
 * something real to render on first run. Runs as the migrator/owner role
 * (DATABASE_URL), which has BYPASSRLS from the enable_rls migration, so it
 * intentionally does NOT go through withTenantContext.
 *
 * Demo staff password for every seeded user (dev/demo only, never a real
 * credential — swap immediately for anything resembling production):
 * "RentOS!Demo2026". The hash below is that password at bcrypt cost 10.
 */
import { createHash } from "node:crypto";
import { PrismaClient, BookingModel, AssetStatus, BookingStatus, type GlobalRole } from "../generated/client/index.js";

const prisma = new PrismaClient();
const DEMO_PASSWORD_HASH = "$2a$10$EvHMo0YpEy8LGcSzJL3DaOr26EZsqN/PuPBclcDWdyDU/b2eD1I.K";

// Fixed (not randomly generated) demo credentials — same convention as
// DEMO_PASSWORD_HASH above: a stable, documented, reseedable demo value,
// not a real secret. Re-running `seed` must not rotate these out from
// under anyone who copied them from a prior run.
const DEMO_API_KEY_PLAINTEXT = "rok_demo_gudang_aman_2026";
const DEMO_WEBHOOK_SECRET = "whsec_demo_gudang_aman_2026";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function seedStaffUser(tenantId: string, email: string, displayName: string, roles: GlobalRole[]) {
  const user = await prisma.user.upsert({
    where: { tenantId_email: { tenantId, email } },
    update: {},
    create: { tenantId, email, displayName, passwordHash: DEMO_PASSWORD_HASH, status: "ACTIVE" },
  });
  for (const role of roles) {
    await prisma.userRole.upsert({
      where: { userId_role: { userId: user.id, role } },
      update: {},
      create: { userId: user.id, role },
    });
  }
  return user;
}

/**
 * PRD Phase 4 tenant-facing API + outbound webhooks (docs/HANDOFF.md
 * Session 20) — demo-only, gudang-aman is the sole tenant with
 * featureFlags.api_access_enabled set. Uses fixed plaintext/secret so the
 * demo credentials survive re-seeding (see DEMO_API_KEY_PLAINTEXT's
 * comment); upserts on the resulting hash so re-running seed is a no-op.
 */
async function seedApiAccessDemo(tenantId: string, createdByUserId: string) {
  const keyHash = sha256Hex(DEMO_API_KEY_PLAINTEXT);
  await prisma.tenantApiKey.upsert({
    where: { keyHash },
    update: {},
    create: {
      tenantId,
      label: "Demo integration key",
      keyPrefix: DEMO_API_KEY_PLAINTEXT.slice(0, 12),
      keyHash,
      createdByUserId,
    },
  });

  const existingSubscription = await prisma.tenantWebhookSubscription.findFirst({
    where: { tenantId, url: "https://example.com/webhooks/rentos" },
  });
  if (!existingSubscription) {
    await prisma.tenantWebhookSubscription.create({
      data: {
        tenantId,
        url: "https://example.com/webhooks/rentos",
        secret: DEMO_WEBHOOK_SECRET,
        eventTypes: ["booking.approved", "invoice.paid", "payment.received"],
        createdByUserId,
      },
    });
  }

  // eslint-disable-next-line no-console
  console.log(
    `Seeded API access demo for tenant ${tenantId} — key "${DEMO_API_KEY_PLAINTEXT}", webhook secret "${DEMO_WEBHOOK_SECRET}".`,
  );
}

async function seedStorageTenant() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "gudang-aman" },
    update: {},
    create: {
      slug: "gudang-aman",
      name: "Gudang Aman Storage",
      legalName: "PT Gudang Aman Sentosa",
      isPkp: true,
      defaultLocale: "id",
      timezone: "Asia/Jakarta",
      branding: { primaryColor: "#0F172A", accentColor: "#F59E0B" },
      // api_access_enabled is Phase 4's tenant-facing API + outbound webhooks
      // (docs/HANDOFF.md Session 20) — deliberately on for this ONE tenant
      // only in the demo, per instruction; griya-nginap and sewa-alat leave
      // it unset (falsy) so ApiKeysService/TenantWebhooksService's
      // assertEnabled() 403s there, same code path either way.
      featureFlags: {
        deposits_enabled: true,
        kyc_required: true,
        auto_approve: false,
        contract_required: false,
        api_access_enabled: true,
      },
    },
  });

  await prisma.tenantDomain.upsert({
    where: { domain: "gudang-aman.rentos.local" },
    update: {},
    create: { tenantId: tenant.id, domain: "gudang-aman.rentos.local", isPrimary: true },
  });

  const location = await prisma.location.upsert({
    where: { id: "00000000-0000-0000-0000-000000000101" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000101",
      tenantId: tenant.id,
      name: "Gudang Aman — Kelapa Gading",
      address: "Jl. Boulevard Raya, Kelapa Gading, Jakarta Utara",
      timezone: "Asia/Jakarta",
    },
  });

  await seedStaffUser(tenant.id, "admin@gudang-aman.test", "Ops Admin", ["OPS_ADMIN"]);
  await seedStaffUser(tenant.id, "finance@gudang-aman.test", "Finance Admin", ["FINANCE_ADMIN"]);
  // SUPER_ADMIN gates ApiKeysController/TenantWebhooksController (API Access
  // console page) — no tenant had a SUPER_ADMIN staff user before this
  // (Phase 4 is the first module to require it), so one is seeded here.
  const superAdmin = await seedStaffUser(tenant.id, "superadmin@gudang-aman.test", "Super Admin", ["SUPER_ADMIN"]);
  await seedApiAccessDemo(tenant.id, superAdmin.id);

  const assetTypeSmall = await prisma.assetType.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: "unit-1-5x2" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Storage Unit 1.5×2m",
      slug: "unit-1-5x2",
      bookingModel: BookingModel.RECURRING_LEASE,
      attributesSchema: { sizeM2: 3, climateControlled: false, floor: "ground" },
      pricing: {
        basePrice: 450000,
        currency: "IDR",
        billingPeriod: "MONTHLY",
        depositRule: { type: "MULTIPLE_OF_RENT", multiple: 1 },
        adminFee: 50000,
        prorationRule: "ANCHOR_DATE",
        taxInclusive: false,
      },
      photos: [],
      isPublished: true,
    },
  });

  const assetTypeMedium = await prisma.assetType.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: "unit-3x3" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Storage Unit 3×3m",
      slug: "unit-3x3",
      bookingModel: BookingModel.RECURRING_LEASE,
      attributesSchema: { sizeM2: 9, climateControlled: true, floor: "ground" },
      pricing: {
        basePrice: 1200000,
        currency: "IDR",
        billingPeriod: "MONTHLY",
        depositRule: { type: "MULTIPLE_OF_RENT", multiple: 1 },
        adminFee: 75000,
        prorationRule: "ANCHOR_DATE",
        taxInclusive: false,
      },
      photos: [],
      isPublished: true,
    },
  });

  const assetCodes: Array<{ code: string; assetTypeId: string; status: AssetStatus }> = [
    { code: "A-01", assetTypeId: assetTypeSmall.id, status: AssetStatus.AVAILABLE },
    { code: "A-02", assetTypeId: assetTypeSmall.id, status: AssetStatus.AVAILABLE },
    { code: "A-03", assetTypeId: assetTypeSmall.id, status: AssetStatus.MAINTENANCE },
    { code: "B-14", assetTypeId: assetTypeMedium.id, status: AssetStatus.OCCUPIED },
    { code: "B-15", assetTypeId: assetTypeMedium.id, status: AssetStatus.AVAILABLE },
  ];

  const assets = [];
  for (const a of assetCodes) {
    const asset = await prisma.asset.upsert({
      where: { tenantId_locationId_code: { tenantId: tenant.id, locationId: location.id, code: a.code } },
      update: {},
      create: {
        tenantId: tenant.id,
        locationId: location.id,
        assetTypeId: a.assetTypeId,
        code: a.code,
        status: a.status,
        attributes: {},
      },
    });
    assets.push(asset);
  }

  const customer = await prisma.customer.upsert({
    where: { tenantId_phone: { tenantId: tenant.id, phone: "+6281234567890" } },
    update: {},
    create: {
      tenantId: tenant.id,
      phone: "+6281234567890",
      email: "budi.santoso@example.com",
      fullName: "Budi Santoso",
      kycStatus: "VERIFIED",
    },
  });

  const occupiedAsset = assets.find((a) => a.code === "B-14")!;
  const existingBooking = await prisma.booking.findFirst({
    where: { tenantId: tenant.id, assetId: occupiedAsset.id, status: BookingStatus.ACTIVE },
  });

  if (!existingBooking) {
    const startDate = new Date();
    startDate.setDate(1);
    await prisma.booking.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        assetTypeId: assetTypeMedium.id,
        assetId: occupiedAsset.id,
        bookingModel: BookingModel.RECURRING_LEASE,
        status: BookingStatus.ACTIVE,
        startDate,
        anchorDay: startDate.getDate(),
        priceSnapshot: {
          basePrice: 1200000,
          currency: "IDR",
          billingPeriod: "MONTHLY",
          adminFee: 75000,
          depositAmount: 1200000,
          taxInclusive: false,
        },
        approvedByUserId: null,
        events: {
          create: [
            { tenantId: tenant.id, toStatus: BookingStatus.PENDING_APPROVAL, actorType: "CUSTOMER", reason: "Booking submitted" },
            { tenantId: tenant.id, fromStatus: BookingStatus.PENDING_APPROVAL, toStatus: BookingStatus.APPROVED, actorType: "SYSTEM", reason: "Seed data" },
            { tenantId: tenant.id, fromStatus: BookingStatus.APPROVED, toStatus: BookingStatus.ACTIVE, actorType: "SYSTEM", reason: "Seed data" },
          ],
        },
      },
    });
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded tenant "${tenant.slug}" (${tenant.id}) with ${assets.length} assets.`);
}

/**
 * Tenant #2 — a homestay/kost operator on NIGHTLY (Session 16). Deliberately
 * NOT PKP-registered (`isPkp: false`), unlike tenant #1 — this is a real,
 * separate tenant exercising `computeTax()`'s non-PKP branch (no PPN line)
 * in an actually-running tenant, not just a unit test. Proves the whole
 * booking->invoice->payment->lifecycle path for a second vertical needs
 * zero application code changes — only these rows.
 */
async function seedHomestayTenant() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "griya-nginap" },
    update: {},
    create: {
      slug: "griya-nginap",
      name: "Griya Nginap Homestay",
      legalName: "CV Griya Nginap Bali",
      isPkp: false,
      defaultLocale: "id",
      timezone: "Asia/Makassar",
      branding: { primaryColor: "#134E4A", accentColor: "#FB923C" },
      featureFlags: { deposits_enabled: true, kyc_required: false, auto_approve: false, contract_required: false },
    },
  });

  await prisma.tenantDomain.upsert({
    where: { domain: "griya-nginap.rentos.local" },
    update: {},
    create: { tenantId: tenant.id, domain: "griya-nginap.rentos.local", isPrimary: true },
  });

  const location = await prisma.location.upsert({
    where: { id: "00000000-0000-0000-0000-000000000201" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000201",
      tenantId: tenant.id,
      name: "Griya Nginap — Seminyak, Bali",
      address: "Jl. Kayu Aya No. 12, Seminyak, Badung, Bali",
      timezone: "Asia/Makassar",
    },
  });

  await seedStaffUser(tenant.id, "ops@griya-nginap.test", "Griya Ops", ["OPS_ADMIN"]);
  await seedStaffUser(tenant.id, "finance@griya-nginap.test", "Griya Finance", ["FINANCE_ADMIN"]);

  const roomStandard = await prisma.assetType.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: "kamar-standard" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Kamar Standard",
      slug: "kamar-standard",
      bookingModel: BookingModel.NIGHTLY,
      attributesSchema: { sizeM2: 18, climateControlled: true },
      pricing: {
        basePrice: 350000,
        currency: "IDR",
        adminFee: 15000,
        depositRule: { type: "FIXED", amount: 200000 },
        taxInclusive: false,
      },
      photos: [],
      isPublished: true,
    },
  });

  const roomDeluxe = await prisma.assetType.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: "kamar-deluxe" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Kamar Deluxe",
      slug: "kamar-deluxe",
      bookingModel: BookingModel.NIGHTLY,
      attributesSchema: { sizeM2: 28, climateControlled: true },
      pricing: {
        basePrice: 650000,
        currency: "IDR",
        adminFee: 25000,
        depositRule: { type: "FIXED", amount: 400000 },
        taxInclusive: false,
        // Seasonal pricing demo (Session 17, PRD §7.2.3 P2): peak
        // Christmas/New Year rate. A stay crossing into this window
        // gets a real per-night breakdown, not a blended average — see
        // NightlyStrategy.computeInitialInvoice.
        seasonalRates: [{ startDate: "2026-12-24", endDate: "2027-01-01", basePrice: 950000, label: "Christmas & New Year" }],
      },
      photos: [],
      isPublished: true,
    },
  });

  /**
   * Pooled inventory demo (Session 17, PRD §5.2 `AssetType.isPooled`):
   * identical dorm beds where a guest doesn't care which specific bed,
   * only that one is free for their dates — availability is a capacity
   * count over a date window, not "is this one exact Asset AVAILABLE
   * right now" (see `computePooledAvailableCount` in @rentos/database).
   * Small pool (2 beds) deliberately, so the overlap/exhaustion behavior
   * is easy to exercise in live verification.
   */
  const dormBed = await prisma.assetType.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: "dorm-bed" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Dorm Bed (Shared Room)",
      slug: "dorm-bed",
      bookingModel: BookingModel.NIGHTLY,
      isPooled: true,
      attributesSchema: { sizeM2: 4, climateControlled: true },
      pricing: {
        basePrice: 120000,
        currency: "IDR",
        adminFee: 5000,
        depositRule: { type: "FIXED", amount: 50000 },
        taxInclusive: false,
      },
      photos: [],
      isPublished: true,
    },
  });

  const assetCodes: Array<{ code: string; assetTypeId: string; status: AssetStatus }> = [
    { code: "R-01", assetTypeId: roomStandard.id, status: AssetStatus.AVAILABLE },
    { code: "R-02", assetTypeId: roomStandard.id, status: AssetStatus.AVAILABLE },
    { code: "R-03", assetTypeId: roomStandard.id, status: AssetStatus.MAINTENANCE },
    { code: "D-01", assetTypeId: roomDeluxe.id, status: AssetStatus.OCCUPIED },
    { code: "D-02", assetTypeId: roomDeluxe.id, status: AssetStatus.AVAILABLE },
    { code: "BED-01", assetTypeId: dormBed.id, status: AssetStatus.AVAILABLE },
    { code: "BED-02", assetTypeId: dormBed.id, status: AssetStatus.AVAILABLE },
  ];

  const assets = [];
  for (const a of assetCodes) {
    const asset = await prisma.asset.upsert({
      where: { tenantId_locationId_code: { tenantId: tenant.id, locationId: location.id, code: a.code } },
      update: {},
      create: {
        tenantId: tenant.id,
        locationId: location.id,
        assetTypeId: a.assetTypeId,
        code: a.code,
        status: a.status,
        attributes: {},
      },
    });
    assets.push(asset);
  }

  const customer = await prisma.customer.upsert({
    where: { tenantId_phone: { tenantId: tenant.id, phone: "+6281298765432" } },
    update: {},
    create: {
      tenantId: tenant.id,
      phone: "+6281298765432",
      email: "wayan.arta@example.com",
      fullName: "Wayan Arta",
      kycStatus: "NOT_SUBMITTED",
    },
  });

  const occupiedAsset = assets.find((a) => a.code === "D-01")!;
  const existingBooking = await prisma.booking.findFirst({
    where: { tenantId: tenant.id, assetId: occupiedAsset.id, status: BookingStatus.CHECKED_IN },
  });

  if (!existingBooking) {
    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 3);
    await prisma.booking.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        assetTypeId: roomDeluxe.id,
        assetId: occupiedAsset.id,
        bookingModel: BookingModel.NIGHTLY,
        status: BookingStatus.CHECKED_IN,
        startDate,
        endDate,
        priceSnapshot: {
          basePrice: 650000,
          currency: "IDR",
          adminFee: 25000,
          depositRule: { type: "FIXED", amount: 400000 },
          taxInclusive: false,
        },
        approvedByUserId: null,
        events: {
          create: [
            { tenantId: tenant.id, toStatus: BookingStatus.PENDING_APPROVAL, actorType: "CUSTOMER", reason: "Booking submitted" },
            { tenantId: tenant.id, fromStatus: BookingStatus.PENDING_APPROVAL, toStatus: BookingStatus.APPROVED, actorType: "SYSTEM", reason: "Seed data" },
            { tenantId: tenant.id, fromStatus: BookingStatus.APPROVED, toStatus: BookingStatus.PAID, actorType: "SYSTEM", reason: "Seed data" },
            { tenantId: tenant.id, fromStatus: BookingStatus.PAID, toStatus: BookingStatus.CHECKED_IN, actorType: "SYSTEM", reason: "Seed data" },
          ],
        },
      },
    });
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded tenant "${tenant.slug}" (${tenant.id}) with ${assets.length} assets.`);
}

/**
 * Tenant #3 — an equipment rental operator on DURATION_ORDER (Session
 * 19). NIGHTLY already had two live tenants (Session 16, 18); a second
 * NIGHTLY tenant would add no new extensibility evidence, but no real
 * tenant had exercised DURATION_ORDER's pickup/return/inspection
 * lifecycle until now. PKP-registered (`isPkp: true`, unlike
 * `griya-nginap`) — a third real data point on the tax branch, and
 * matches how an equipment-rental CV would typically be registered.
 */
async function seedEquipmentTenant() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "sewa-alat" },
    update: {},
    create: {
      slug: "sewa-alat",
      name: "Sewa Alat Jaya",
      legalName: "CV Sewa Alat Jaya",
      isPkp: true,
      defaultLocale: "id",
      timezone: "Asia/Jakarta",
      branding: { primaryColor: "#7C2D12", accentColor: "#EAB308" },
      // kyc_auto_verification_enabled is Phase 4's automated KYC
      // (docs/HANDOFF.md Session 21) — deliberately on for this ONE tenant
      // only in the demo (diversifying away from gudang-aman, which
      // already has Session 20's api_access_enabled flag), so the
      // extensibility of the feature-flag pattern itself is demonstrated
      // across two different tenants, not just one. griya-nginap doesn't
      // even have kyc_required on, so it wouldn't be a meaningful demo
      // target for this flag regardless.
      featureFlags: {
        deposits_enabled: true,
        kyc_required: true,
        auto_approve: false,
        contract_required: false,
        kyc_auto_verification_enabled: true,
      },
    },
  });

  await prisma.tenantDomain.upsert({
    where: { domain: "sewa-alat.rentos.local" },
    update: {},
    create: { tenantId: tenant.id, domain: "sewa-alat.rentos.local", isPrimary: true },
  });

  const location = await prisma.location.upsert({
    where: { id: "00000000-0000-0000-0000-000000000301" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000301",
      tenantId: tenant.id,
      name: "Sewa Alat Jaya — Bandung",
      address: "Jl. Soekarno-Hatta No. 88, Bandung, Jawa Barat",
      timezone: "Asia/Jakarta",
    },
  });

  await seedStaffUser(tenant.id, "ops@sewa-alat.test", "Sewa Alat Ops", ["OPS_ADMIN"]);
  await seedStaffUser(tenant.id, "finance@sewa-alat.test", "Sewa Alat Finance", ["FINANCE_ADMIN"]);

  const genset = await prisma.assetType.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: "genset-5kva" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Genset 5kVA",
      slug: "genset-5kva",
      bookingModel: BookingModel.DURATION_ORDER,
      attributesSchema: { powerKva: 5, fuelType: "diesel" },
      pricing: {
        basePrice: 150000,
        currency: "IDR",
        adminFee: 20000,
        depositRule: { type: "FIXED", amount: 1000000 },
        taxInclusive: false,
      },
      photos: [],
      isPublished: true,
    },
  });

  const scaffolding = await prisma.assetType.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: "perancah-set" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Perancah Set (Scaffolding)",
      slug: "perancah-set",
      bookingModel: BookingModel.DURATION_ORDER,
      attributesSchema: { heightM: 6, panels: 8 },
      pricing: {
        basePrice: 90000,
        currency: "IDR",
        adminFee: 15000,
        depositRule: { type: "FIXED", amount: 750000 },
        taxInclusive: false,
      },
      photos: [],
      isPublished: true,
    },
  });

  const assetCodes: Array<{ code: string; assetTypeId: string; status: AssetStatus }> = [
    { code: "GEN-01", assetTypeId: genset.id, status: AssetStatus.OCCUPIED },
    { code: "GEN-02", assetTypeId: genset.id, status: AssetStatus.AVAILABLE },
    { code: "GEN-03", assetTypeId: genset.id, status: AssetStatus.MAINTENANCE },
    { code: "SCF-01", assetTypeId: scaffolding.id, status: AssetStatus.AVAILABLE },
  ];

  const assets = [];
  for (const a of assetCodes) {
    const asset = await prisma.asset.upsert({
      where: { tenantId_locationId_code: { tenantId: tenant.id, locationId: location.id, code: a.code } },
      update: {},
      create: {
        tenantId: tenant.id,
        locationId: location.id,
        assetTypeId: a.assetTypeId,
        code: a.code,
        status: a.status,
        attributes: {},
      },
    });
    assets.push(asset);
  }

  const customer = await prisma.customer.upsert({
    where: { tenantId_phone: { tenantId: tenant.id, phone: "+6281255551234" } },
    update: {},
    create: {
      tenantId: tenant.id,
      phone: "+6281255551234",
      email: "dedi.kurniawan@example.com",
      fullName: "Dedi Kurniawan",
      kycStatus: "VERIFIED",
    },
  });

  const pickedUpAsset = assets.find((a) => a.code === "GEN-01")!;
  const existingBooking = await prisma.booking.findFirst({
    where: { tenantId: tenant.id, assetId: pickedUpAsset.id, status: BookingStatus.PICKED_UP },
  });

  if (!existingBooking) {
    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 5);
    await prisma.booking.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        assetTypeId: genset.id,
        assetId: pickedUpAsset.id,
        bookingModel: BookingModel.DURATION_ORDER,
        status: BookingStatus.PICKED_UP,
        startDate,
        endDate,
        priceSnapshot: {
          basePrice: 150000,
          currency: "IDR",
          adminFee: 20000,
          depositRule: { type: "FIXED", amount: 1000000 },
          taxInclusive: false,
        },
        approvedByUserId: null,
        events: {
          create: [
            { tenantId: tenant.id, toStatus: BookingStatus.PENDING_APPROVAL, actorType: "CUSTOMER", reason: "Order submitted" },
            { tenantId: tenant.id, fromStatus: BookingStatus.PENDING_APPROVAL, toStatus: BookingStatus.APPROVED, actorType: "SYSTEM", reason: "Seed data" },
            { tenantId: tenant.id, fromStatus: BookingStatus.APPROVED, toStatus: BookingStatus.PAID, actorType: "SYSTEM", reason: "Seed data" },
            { tenantId: tenant.id, fromStatus: BookingStatus.PAID, toStatus: BookingStatus.PICKED_UP, actorType: "SYSTEM", reason: "Seed data" },
          ],
        },
      },
    });
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded tenant "${tenant.slug}" (${tenant.id}) with ${assets.length} assets.`);
}

async function main() {
  await seedStorageTenant();
  await seedHomestayTenant();
  await seedEquipmentTenant();
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
