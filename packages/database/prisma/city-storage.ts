/**
 * City Storage bootstrap from the Kebon Jeruk data pack
 * (prisma/data/kebon-jeruk/, PRD go-live §5 and §11).
 *
 * Shared by both seed modes:
 *   - SEED_MODE=production: this, and nothing else. No users, no customers,
 *     no units (units come from the unit importer once every row has a type),
 *     no demo anything.
 *   - demo (default): this, then the demo users/customers on top (seed.ts).
 *
 * Idempotent: every write is an upsert keyed on a natural key, and an upsert
 * on an existing row only rewrites the fields the data pack owns. Re-running
 * it after staff edited the branch in Settings → Branch WOULD overwrite those
 * edits, so production runs it once, at bootstrap.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { BookingModel, type Prisma, type PrismaClient } from "../generated/client/index.js";
import { parseCsv } from "../src/imports/csv.js";

export { parseCsv };

export const DATA_DIR = path.join(__dirname, "data", "kebon-jeruk");

interface BranchProfile {
  organization: { legalName: string; brandName: string; systemWhatsapp?: string | null };
  tenant: {
    slug: string;
    branchCode: string;
    name: string;
    timezone: string;
    defaultLocale: string;
    isPkp: boolean;
    location: { name: string; addressLines: string[]; latitude: number | null; longitude: number | null };
    customerService: { whatsapp: string | null; phone: string; email: string };
    operatingHours: Record<string, string>;
    bankAccounts: Array<{ bank: string; accountNumber: string; accountName: string; swift?: string; showOnInvoice: boolean }>;
    facilities: string[];
    commercialRules: Record<string, unknown>;
  };
}

export function readBranchProfile(): BranchProfile {
  return JSON.parse(readFileSync(path.join(DATA_DIR, "kebon-jeruk-branch-profile.json"), "utf8")) as BranchProfile;
}

interface UnitTypeRow {
  slug: string;
  name: string;
  size_class: string;
  size_m3: string;
  size_label: string;
  monthly_price_idr: string;
  admin_fee_idr: string;
  min_term_months: string;
  tax_inclusive: string;
}

export function readUnitTypes(): UnitTypeRow[] {
  return parseCsv(readFileSync(path.join(DATA_DIR, "kebon-jeruk-unit-types.csv"), "utf8")) as unknown as UnitTypeRow[];
}

/** The T&C body stored as ContractTerms v1: the file minus its provenance preamble. */
export function readContractTerms(): string {
  const raw = readFileSync(path.join(DATA_DIR, "contract-terms-id-en.md"), "utf8");
  const start = raw.indexOf("## Bahasa Indonesia");
  return start >= 0 ? raw.slice(start) : raw;
}

export const CITY_STORAGE_NUMBERING_FORMAT = {
  contract: "{BRANCH}-{M}-{YYYY}-{CUST}-{SEQ}",
  invoice: "{BRANCH}-{M}-{YYYY}-{CUST}-{SEQ}",
  creditNote: "{BRANCH}-CN-{M}-{YYYY}-{CUST}-{SEQ}",
  seqReset: "never",
};

/** Indonesian label for a WhatsApp number in the profile: +628111877838 -> +62 811-1877-838. */
function prettyPhone(e164: string): string {
  const m = /^\+62(\d{3})(\d{4})(\d+)$/.exec(e164);
  return m ? `+62 ${m[1]}-${m[2]}-${m[3]}` : e164;
}

export async function bootstrapCityStorage(prisma: PrismaClient, opts: { mode: "production" | "demo" }) {
  const profile = readBranchProfile();
  const t = profile.tenant;

  const org = await prisma.organization.upsert({
    where: { slug: "city-storage" },
    update: { name: profile.organization.brandName, legalName: profile.organization.legalName },
    create: {
      slug: "city-storage",
      name: profile.organization.brandName,
      legalName: profile.organization.legalName,
      messagingConfig: {},
      // A fresh production database starts with messaging PAUSED: nothing can
      // reach a customer until staff have reviewed the setup and unpaused it
      // (PRD go-live §1.2, §9.1, §10.2).
      messagingPaused: opts.mode === "production",
      messagingPausedReason: opts.mode === "production" ? "Production bootstrap — unpause after go-live review" : null,
      messagingPausedAt: opts.mode === "production" ? new Date() : null,
      taxConfig: { pphRates: { PPH_4_2_FINAL: 0.1, PPH_23: 0.02 }, defaultPphType: "PPH_4_2_FINAL" },
    },
  });

  // The organization-wide system number (owner, 2026-11-09): every customer
  // message is sent from it. Kept with the messaging config so Settings →
  // Branch can refuse it as a CS contact and the auto-reply never points at it.
  if (profile.organization.systemWhatsapp) {
    const current = (org.messagingConfig ?? {}) as Record<string, unknown>;
    if (current.systemWhatsapp !== profile.organization.systemWhatsapp) {
      await prisma.organization.update({
        where: { id: org.id },
        data: { messagingConfig: { ...current, systemWhatsapp: profile.organization.systemWhatsapp } as Prisma.InputJsonValue },
      });
    }
  }

  const featureFlags: Prisma.InputJsonValue = {
    deposits_enabled: true,
    kyc_required: true,
    auto_approve: false,
    contract_required: true,
    allowSubMonthly: false,
    paymentMethods: ["MANUAL_TRANSFER", "CARD"],
    // PRD go-live §4.3 — off until the client's Xendit account exists (set below).
    onlinePaymentsEnabled: false,
    // The external API stays off in production until §15's key scopes land.
    api_access_enabled: opts.mode === "demo",
    blackout_months: 1,
    invoice_lead_days: 7,
  };

  const profileFields = {
    name: t.name,
    legalName: profile.organization.legalName,
    branchCode: t.branchCode,
    isPkp: t.isPkp,
    defaultLocale: t.defaultLocale,
    timezone: t.timezone,
    contact: {
      // Never the system number (organization.systemWhatsapp): that one only sends.
      whatsapp: t.customerService.whatsapp,
      whatsappDisplay: t.customerService.whatsapp ? prettyPhone(t.customerService.whatsapp) : null,
      phone: t.customerService.phone,
      email: t.customerService.email,
      csDisplayName: `CS ${t.name}`,
    },
    address: t.location.addressLines,
    operatingHours: t.operatingHours,
    bankAccounts: t.bankAccounts,
    facilities: t.facilities,
    numbering: CITY_STORAGE_NUMBERING_FORMAT,
  };

  const tenant = await prisma.tenant.upsert({
    where: { slug: t.slug },
    update: { organizationId: org.id, ...profileFields },
    create: {
      organizationId: org.id,
      slug: t.slug,
      ...profileFields,
      branding: { primaryColor: "#0F172A", accentColor: "#F26522" },
      featureFlags,
    },
  });
  // An existing tenant keeps its other flags. Production never keeps online
  // payment on from an earlier demo seed; the demo (staging) tenant has it on,
  // because there the mock gateway is the point.
  // The City Storage logo, from the client's own quotation PDF, for the
  // document header (and anywhere else that wants it as a data URL).
  const logoPath = path.join(DATA_DIR, "city-storage-logo.png");
  const branding = { ...((tenant.branding as Record<string, unknown>) ?? {}), logoPngBase64: readFileSync(logoPath).toString("base64") };
  await prisma.tenant.update({ where: { id: tenant.id }, data: { branding: branding as Prisma.InputJsonValue } });

  const flags = {
    ...((tenant.featureFlags as Record<string, unknown>) ?? {}),
    onlinePaymentsEnabled: opts.mode === "demo",
    ...(opts.mode === "production" ? { api_access_enabled: false } : {}),
  };
  await prisma.tenant.update({ where: { id: tenant.id }, data: { featureFlags: flags as Prisma.InputJsonValue } });

  const LOCATION_ID = "00000000-0000-0000-0000-000000000101";
  await prisma.location.upsert({
    where: { id: LOCATION_ID },
    update: {
      name: t.location.name,
      address: t.location.addressLines.join(", "),
      ...(t.location.latitude !== null && t.location.longitude !== null ? { latitude: t.location.latitude, longitude: t.location.longitude } : {}),
    },
    create: {
      id: LOCATION_ID,
      tenantId: tenant.id,
      name: t.location.name,
      address: t.location.addressLines.join(", "),
      timezone: t.timezone,
      // The data pack leaves coordinates to be filled from the Maps pin
      // (§11). Until then, the approximate Kebon Jeruk point the old seed used keeps
      // the storefront's branch map usable; Settings → Branch corrects it.
      latitude: t.location.latitude ?? -6.1944,
      longitude: t.location.longitude ?? 106.7692,
    },
  });

  const assetTypes = [];
  for (const row of readUnitTypes()) {
    const price = Number(row.monthly_price_idr);
    const sizeClass = row.size_class;
    const data = {
      name: row.name,
      bookingModel: BookingModel.RECURRING_LEASE,
      attributesSchema: { sizeM3: Number(row.size_m3), sizeLabel: row.size_label.replace(/m3$/, "m³").replace(/(\d)-(\d)/, "$1–$2"), sizeClass },
      pricing: {
        basePrice: price,
        currency: "IDR",
        billingPeriod: "MONTHLY",
        // "1x monthly rent" (quotation + T&C IV.2).
        depositRule: { type: "MULTIPLE_OF_RENT", multiple: 1 },
        adminFee: Number(row.admin_fee_idr || 0),
        minTermMonths: Number(row.min_term_months || 1),
        taxInclusive: row.tax_inclusive === "true",
      },
      // Free Style is unpublished until the client answers §16 Q3 (pooled
      // band or fixed units). The storefront already groups it separately.
      isPublished: sizeClass !== "FREESTYLE",
    };
    assetTypes.push(
      await prisma.assetType.upsert({
        where: { tenantId_slug: { tenantId: tenant.id, slug: row.slug } },
        update: data,
        create: { tenantId: tenant.id, slug: row.slug, photos: [], ...data },
      }),
    );
  }

  const existingTerms = await prisma.contractTerms.findFirst({ where: { organizationId: org.id }, orderBy: { version: "desc" } });
  if (!existingTerms) {
    await prisma.contractTerms.create({ data: { organizationId: org.id, version: 1, body: readContractTerms() } });
  }

  return { org, tenant, assetTypes, locationId: LOCATION_ID };
}
