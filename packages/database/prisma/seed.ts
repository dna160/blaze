/**
 * Seeds tenant #1 — a self-storage operator — with demo AssetTypes, Assets,
 * a customer, and one ACTIVE lease so the storefront/console have
 * something real to render on first run. Runs as the migrator/owner role
 * (DATABASE_URL), which has BYPASSRLS from the enable_rls migration, so it
 * intentionally does NOT go through withTenantContext.
 */
import { PrismaClient, BookingModel, AssetStatus, BookingStatus } from "../generated/client/index.js";

const prisma = new PrismaClient();

async function main() {
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
      featureFlags: { deposits_enabled: true, kyc_required: true, auto_approve: false },
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

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
