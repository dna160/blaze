/**
 * Confirms staff console login works against the CURRENT seed tenant slug
 * (city-storage-kebon-jeruk) — the fix for the "can't login" report (the console
 * was pointed at the old 'gudang-aman' slug that the new seed no longer creates).
 *
 * Run: DATABASE_URL=... DATABASE_URL_APP=... REDIS_URL=... JWT_SECRET=x tsx apps/api/scripts/login-verify.ts
 */
import { JwtService } from "@nestjs/jwt";

import { AuthService } from "../src/auth/auth.service.js";
import { CrmService } from "../src/crm/crm.service.js";
import { NotificationsService } from "../src/notifications/notifications.service.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { TenancyService } from "../src/tenancy/tenancy.service.js";

const SLUG = "city-storage-kebon-jeruk";

async function main() {
  const prisma = new PrismaService();
  const redis = new RedisService();
  const jwt = new JwtService({ secret: process.env.JWT_SECRET });
  const auth = new AuthService(prisma, jwt, redis, new CrmService(prisma), new NotificationsService(prisma, { send: async () => ({ providerRef: "x" }) } as never));
  const tenancy = new TenancyService(prisma);

  const results: string[] = [];
  let pass = true;
  const check = (l: string, ok: boolean) => { results.push(`${ok ? "✅" : "❌"} ${l}`); if (!ok) pass = false; };

  const tenant = await tenancy.resolveBySlug(SLUG);
  check(`tenant slug "${SLUG}" resolves`, tenant.slug === SLUG);

  const sa = await auth.consoleLogin(tenant, "superadmin@citystorage.test", "RentOS!Demo2026");
  check("super admin logs in (RentOS!Demo2026)", Boolean(sa.accessToken) && sa.user.roles.includes("ADMIN"));
  check("super admin token carries ORGANIZATION scope", sa.user.roleAssignments.some((r) => r.scope === "ORGANIZATION"));

  const fin = await auth.consoleLogin(tenant, "finance@dummy.test", "Finance123!");
  check("dummy finance logs in (Finance123!)", Boolean(fin.accessToken) && fin.user.roles.includes("FINANCE"));

  let wrongRejected = false;
  try { await auth.consoleLogin(tenant, "superadmin@citystorage.test", "wrong"); } catch { wrongRejected = true; }
  check("wrong password rejected", wrongRejected);

  console.log("=== staff login (current seed slug) ===");
  results.forEach((r) => console.log(r));
  console.log(pass ? "RESULT: PASS ✅" : "RESULT: FAIL ❌");
  await redis.client.quit(); await prisma.onModuleDestroy();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
