/**
 * BUILD-SPEC C2 — verify the staff user-admin surface and its guards:
 *  - a Super Admin (ADMIN@ORG) can create TENANT and ORGANIZATION-scoped users
 *    and LISTS across every branch (read-only org scope);
 *  - a branch Admin (ADMIN@TENANT) can create TENANT users but is BLOCKED from
 *    granting an ORGANIZATION-scoped role (no privilege escalation) and only
 *    LISTS its own branch.
 *
 * Run: DATABASE_URL=... DATABASE_URL_APP=... tsx apps/api/scripts/users-admin-verify.ts
 */
import { PrismaClient } from "@rentos/database";

import { PrismaService } from "../src/prisma/prisma.service.js";
import { UsersService } from "../src/users/users.service.js";
import type { AuthenticatedUser } from "../src/common/types/express-request.js";
import type { ResolvedTenant } from "../src/tenancy/tenancy.service.js";

const ORG = "00000000-0000-0000-0000-0000000000a0";
const A = "00000000-0000-0000-0000-0000000000a1";
const B = "00000000-0000-0000-0000-0000000000a2";

const tenantA: ResolvedTenant = { id: A, organizationId: ORG, slug: "ua", name: "Branch A", isPkp: true, defaultLocale: "id", timezone: "Asia/Jakarta", featureFlags: {} };

const superAdmin: AuthenticatedUser = { id: "00000000-0000-0000-0000-0000000000a8", tenantId: A, organizationId: ORG, kind: "STAFF", roles: ["ADMIN"], roleAssignments: [{ role: "ADMIN", scope: "ORGANIZATION", tenantIds: [] }] };
const branchAdmin: AuthenticatedUser = { id: "00000000-0000-0000-0000-0000000000a9", tenantId: A, organizationId: ORG, kind: "STAFF", roles: ["ADMIN"], roleAssignments: [{ role: "ADMIN", scope: "TENANT", tenantIds: [A] }] };

async function main() {
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
  for (const t of ["user_roles"]) await db.$executeRawUnsafe(`DELETE FROM ${t} WHERE user_id IN (SELECT id FROM users WHERE tenant_id IN ('${A}','${B}'))`);
  await db.$executeRawUnsafe(`DELETE FROM users WHERE tenant_id IN ('${A}','${B}')`);
  await db.$executeRawUnsafe(`DELETE FROM tenants WHERE id IN ('${A}','${B}')`);
  await db.$executeRawUnsafe(`DELETE FROM organizations WHERE id = '${ORG}'`);
  await db.organization.create({ data: { id: ORG, slug: "ua-org", name: "UA Org" } });
  await db.tenant.create({ data: { id: A, organizationId: ORG, slug: "ua", name: "Branch A", isPkp: true } });
  await db.tenant.create({ data: { id: B, organizationId: ORG, slug: "ub", name: "Branch B", isPkp: true } });
  // A pre-existing user in Branch B, to prove org-wide listing.
  await db.user.create({ data: { tenantId: B, email: "staff@b.test", displayName: "B Staff", status: "ACTIVE", roles: { create: { role: "STAFF", scope: "TENANT", tenantIds: [B] } } } });

  const prisma = new PrismaService();
  const users = new UsersService(prisma);
  const results: string[] = [];
  let pass = true;
  const check = (label: string, ok: boolean) => { results.push(`${ok ? "✅" : "❌"} ${label}`); if (!ok) pass = false; };

  // 1. Super Admin creates a TENANT staff user.
  const s1 = await users.createUser(superAdmin, tenantA, { email: "clerk@a.test", displayName: "Clerk", password: "pw12345678", role: "STAFF", scope: "TENANT" });
  check("super admin creates TENANT staff (tenantIds=[A])", s1.roles[0]?.scope === "TENANT" && s1.roles[0]?.tenantIds[0] === A);

  // 2. Super Admin grants an ORGANIZATION-scoped role.
  const s2 = await users.createUser(superAdmin, tenantA, { email: "hofin@a.test", displayName: "HO Finance", password: "pw12345678", role: "FINANCE", scope: "ORGANIZATION" });
  check("super admin grants ORGANIZATION role", s2.roles[0]?.scope === "ORGANIZATION");

  // 3. Branch Admin is BLOCKED from granting an ORGANIZATION role.
  let blocked = false;
  try { await users.createUser(branchAdmin, tenantA, { email: "sneaky@a.test", displayName: "Sneaky", password: "pw12345678", role: "ADMIN", scope: "ORGANIZATION" }); }
  catch { blocked = true; }
  check("branch admin BLOCKED from granting ORGANIZATION role (no escalation)", blocked);

  // 4. Branch Admin CAN create a TENANT user.
  const s4 = await users.createUser(branchAdmin, tenantA, { email: "clerk2@a.test", displayName: "Clerk 2", password: "pw12345678", role: "SUPERVISOR", scope: "TENANT" });
  check("branch admin creates TENANT supervisor", s4.roles[0]?.role === "SUPERVISOR");

  // 5. Super Admin lists across the ORG (sees Branch B's user); branch admin sees only A.
  const orgList = await users.listUsers(superAdmin, tenantA);
  const branchList = await users.listUsers(branchAdmin, tenantA);
  check("super admin lists across org (sees Branch B user)", orgList.some((u) => u.email === "staff@b.test"));
  check("branch admin lists only its branch (does NOT see Branch B user)", !branchList.some((u) => u.email === "staff@b.test"));

  console.log("=== C2 user-admin guards ===");
  results.forEach((r) => console.log(r));
  console.log(pass ? "RESULT: PASS ✅" : "RESULT: FAIL ❌");
  await db.$disconnect(); await prisma.onModuleDestroy();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
