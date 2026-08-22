/**
 * DEV OTP bypass verification. Proves: with DEV_OTP_BYPASS_CODE set and
 * NODE_ENV != production, submitting that code logs a customer in (creating them)
 * for +6281947888808; a wrong code is still rejected; and in production the
 * bypass is IGNORED (the fixed code is rejected). Runs the real AuthService.
 *
 * Run: DATABASE_URL=... DATABASE_URL_APP=... REDIS_URL=... JWT_SECRET=x tsx apps/api/scripts/otp-bypass-verify.ts
 */
import { JwtService } from "@nestjs/jwt";
import { PrismaClient } from "@rentos/database";

import { AuthService } from "../src/auth/auth.service.js";
import { CrmService } from "../src/crm/crm.service.js";
import { NotificationsService } from "../src/notifications/notifications.service.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import type { ResolvedTenant } from "../src/tenancy/tenancy.service.js";

const PHONE = "+6281947888808";

async function main() {
  const seed = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
  const t = await seed.tenant.findFirstOrThrow({ where: { slug: "city-storage-kebon-jeruk" } });
  await seed.$executeRawUnsafe(`DELETE FROM customer_phones WHERE phone='${PHONE}'`);
  await seed.$executeRawUnsafe(`DELETE FROM customers WHERE phone='${PHONE}'`);

  const tenant: ResolvedTenant = { id: t.id, organizationId: t.organizationId, slug: t.slug, name: t.name, isPkp: t.isPkp, defaultLocale: t.defaultLocale, timezone: t.timezone, featureFlags: {} };

  const prisma = new PrismaService();
  const redis = new RedisService();
  const jwt = new JwtService({ secret: process.env.JWT_SECRET });
  const crm = new CrmService(prisma);
  const notifications = new NotificationsService(prisma, { send: async () => ({ providerRef: "x" }) } as never);
  const auth = new AuthService(prisma, jwt, redis, crm, notifications);

  const results: string[] = [];
  let pass = true;
  const check = (label: string, ok: boolean) => { results.push(`${ok ? "✅" : "❌"} ${label}`); if (!ok) pass = false; };

  // Case 1 — dev bypass enabled: 000000 logs in and creates the customer.
  process.env.NODE_ENV = "development";
  process.env.DEV_OTP_BYPASS_CODE = "000000";
  const r = await auth.verifyOtp(tenant, PHONE, "000000");
  check("bypass 000000 returns a token for +6281947888808", Boolean(r.accessToken) && r.customer.phone === PHONE);
  const created = await seed.customer.findUnique({ where: { tenantId_phone: { tenantId: t.id, phone: PHONE } } });
  check("customer +6281947888808 was created on login", Boolean(created));

  // Case 2 — a non-bypass code is still rejected (no real OTP was requested).
  let wrongRejected = false;
  try { await auth.verifyOtp(tenant, PHONE, "111111"); } catch { wrongRejected = true; }
  check("wrong code (111111) rejected", wrongRejected);

  // Case 3 — production IGNORES the bypass even with the env var set.
  process.env.NODE_ENV = "production";
  let prodRejected = false;
  try { await auth.verifyOtp(tenant, PHONE, "000000"); } catch { prodRejected = true; }
  check("production ignores bypass (000000 rejected)", prodRejected);

  console.log("=== DEV OTP bypass ===");
  results.forEach((r) => console.log(r));
  console.log(pass ? "RESULT: PASS ✅" : "RESULT: FAIL ❌");

  await redis.client.quit();
  await prisma.onModuleDestroy();
  await seed.$disconnect();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
