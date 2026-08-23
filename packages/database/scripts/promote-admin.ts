/**
 * Grant a staff user ADMIN x ORGANIZATION on a tenant, creating them if needed.
 *
 * Why this exists: 20260809120000_r0_r2_schema_renewal deletes every user_roles
 * row, because six flat GlobalRoles collapse into four BaseRoles x two scopes
 * with no lossless mapping. After it runs, existing staff can still
 * authenticate but hold no capabilities — the console loads and then 403s on
 * everything. `prisma db seed` re-provisions the DEMO users, but only on the
 * tenant the seed itself creates; a pre-existing tenant is left with nobody who
 * can act on it, and there is no bootstrap path back in through the UI.
 *
 * Run via the API's release step (see apps/api/start.sh):
 *   PROMOTE_ADMIN_EMAIL=you@example.com
 *   PROMOTE_ADMIN_TENANT=<slug[,slug...]>  # optional when there is exactly one
 *   PROMOTE_ADMIN_PASSWORD=<password>      # optional; sets/resets it
 *
 * A comma-separated list grants on each named tenant. Console login is scoped
 * to one tenant — it looks the user up by (tenantId, email) — so an operator
 * who does not know which tenant a given console build points at can name the
 * candidates rather than deploy once per guess.
 *
 * Runs as the migrator/owner role (DATABASE_URL), like the seed, so it does not
 * go through withTenantContext.
 */
import { hash } from "bcryptjs";

import { PrismaClient, BaseRole, RoleScope } from "../generated/client/index.js";

const prisma = new PrismaClient();
const SALT_ROUNDS = 10;

async function main() {
  const email = process.env.PROMOTE_ADMIN_EMAIL?.trim();
  const slug = process.env.PROMOTE_ADMIN_TENANT?.trim();
  const password = process.env.PROMOTE_ADMIN_PASSWORD;

  if (!email) throw new Error("PROMOTE_ADMIN_EMAIL is required.");

  const tenants = await prisma.tenant.findMany({ select: { id: true, slug: true, name: true }, orderBy: { slug: "asc" } });
  if (tenants.length === 0) throw new Error("No tenants exist — run the seed first.");

  const requested = slug ? slug.split(",").map((v) => v.trim()).filter(Boolean) : [];
  let targets;
  if (requested.length > 0) {
    const missing = requested.filter((r) => !tenants.some((t) => t.slug === r));
    if (missing.length > 0) {
      throw new Error(`No tenant with slug ${missing.map((m) => `"${m}"`).join(", ")}. Available: ${tenants.map((t) => t.slug).join(", ")}`);
    }
    targets = tenants.filter((t) => requested.includes(t.slug));
  } else if (tenants.length === 1) {
    targets = tenants;
  } else {
    // Refuse to guess: picking the wrong tenant silently grants admin on the
    // wrong branch, which is worse than making the caller name it.
    throw new Error(`PROMOTE_ADMIN_TENANT is required — ${tenants.length} tenants exist: ${tenants.map((t) => t.slug).join(", ")}`);
  }

  const passwordHash = password ? await hash(password, SALT_ROUNDS) : undefined;

  for (const tenant of targets) {
    const existing = await prisma.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email } } });
    if (!existing && !passwordHash) {
      throw new Error(`User ${email} does not exist on ${tenant.slug}; PROMOTE_ADMIN_PASSWORD is required to create it.`);
    }

    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: { status: "ACTIVE", ...(passwordHash ? { passwordHash } : {}) },
        })
      : await prisma.user.create({
          data: { tenantId: tenant.id, email, displayName: email.split("@")[0]!, passwordHash: passwordHash!, status: "ACTIVE" },
        });

    // ORGANIZATION scope with an empty tenantIds reaches every branch in the org —
    // the "Super Admin (HO)" cell of docs/RBAC.md §2. tenantIds only narrows a
    // TENANT-scoped role.
    await prisma.userRole.upsert({
      where: { userId_role_scope: { userId: user.id, role: BaseRole.ADMIN, scope: RoleScope.ORGANIZATION } },
      update: { tenantIds: [] },
      create: { userId: user.id, role: BaseRole.ADMIN, scope: RoleScope.ORGANIZATION, tenantIds: [] },
    });

    // eslint-disable-next-line no-console
    console.log(
      `Granted ADMIN x ORGANIZATION to ${email} on tenant "${tenant.slug}" (${tenant.name})` +
        `${existing ? "" : " — user created"}${passwordHash ? ", password set" : ""}.`,
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error(e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });
