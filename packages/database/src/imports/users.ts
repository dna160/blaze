import { createHash, randomBytes } from "node:crypto";

import type { PrismaClient } from "../../generated/client/index.js";
import { withTenantContext } from "../tenant-context.js";

import { parseCsv } from "./csv.js";

/**
 * PRD go-live §4.4 — staff accounts from go-live-users.csv:
 *   email, display_name, role, scope, branch_slug, notes
 *
 * No passwords, shared or otherwise: each created user gets a single-use
 * set-password link (UserPasswordToken, SHA-256 stored, 72h). The caller
 * delivers it (email via the notify path, or the console shows it so an admin
 * can send it by WhatsApp) — and, in production, the first Super Admin is
 * created by the CLI (apps/api/scripts/import-users.ts), which prints it.
 *
 * Idempotent: an email that already exists in its branch is reported as
 * "exists" and left alone.
 */

const ROLES = ["ADMIN", "FINANCE", "SUPERVISOR", "STAFF"] as const;
const SCOPES = ["ORGANIZATION", "TENANT"] as const;
export const PASSWORD_LINK_TTL_HOURS = 72;

export interface UserImportRow {
  line: number;
  email: string;
  displayName: string;
  role: string;
  scope: string;
  branchSlug: string | null;
  /** The branch the account lives in (its login tenant). */
  homeTenantId: string | null;
  action: "create" | "exists" | "error";
  errors: string[];
}

export interface UserImportPlan {
  rows: UserImportRow[];
  summary: { create: number; exists: number; error: number };
  canApply: boolean;
}

export interface CreatedUserLink {
  email: string;
  displayName: string;
  branchSlug: string;
  /** The raw token — shown/sent once, never stored. */
  token: string;
  userId: string;
  tenantId: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hashPasswordToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * @param defaultTenantId home branch for ORGANIZATION-scoped rows that leave
 *   branch_slug empty (the importing admin's active branch, or the org's first).
 * @param allowedTenantIds when set, rows outside these branches are errors
 *   (a branch Admin may only import into their own branch).
 */
export async function planUserImport(
  prisma: PrismaClient,
  params: { organizationId: string; csv: string; defaultTenantId: string | null; allowedTenantIds?: string[]; allowOrganizationScope: boolean },
): Promise<UserImportPlan> {
  const tenants = await prisma.tenant.findMany({ where: { organizationId: params.organizationId }, select: { id: true, slug: true } });
  const bySlug = new Map(tenants.map((t) => [t.slug, t.id]));
  const seen = new Map<string, number>();

  const rows: UserImportRow[] = [];
  for (const [i, r] of parseCsv(params.csv).entries()) {
    const line = i + 2;
    const email = (r.email ?? "").trim().toLowerCase();
    const displayName = (r.display_name ?? "").trim();
    const role = (r.role ?? "").trim().toUpperCase();
    const scope = (r.scope ?? "").trim().toUpperCase();
    const branchSlug = (r.branch_slug ?? "").trim() || null;
    const errors: string[] = [];

    if (!EMAIL.test(email)) errors.push(email ? `"${email}" is not an email address` : "email is empty");
    else if (seen.has(email)) errors.push(`duplicate email (also on line ${seen.get(email)})`);
    if (email) seen.set(email, line);
    if (!displayName) errors.push("display_name is empty");
    if (!(ROLES as readonly string[]).includes(role)) errors.push(`role must be one of ${ROLES.join(", ")}`);
    if (!(SCOPES as readonly string[]).includes(scope)) errors.push(`scope must be ORGANIZATION or TENANT`);
    if (scope === "ORGANIZATION" && !params.allowOrganizationScope) errors.push("only an organization-scoped Admin can create organization-wide users");
    if (scope === "TENANT" && !branchSlug) errors.push("branch_slug is required for a TENANT-scoped user");
    if (branchSlug && !bySlug.has(branchSlug)) errors.push(`unknown branch_slug "${branchSlug}"`);

    const homeTenantId = branchSlug ? (bySlug.get(branchSlug) ?? null) : params.defaultTenantId ?? tenants[0]?.id ?? null;
    if (homeTenantId && params.allowedTenantIds && !params.allowedTenantIds.includes(homeTenantId)) errors.push("outside the branches you administer");

    let action: UserImportRow["action"] = errors.length ? "error" : "create";
    if (action === "create" && homeTenantId) {
      const existing = await withTenantContext(prisma, homeTenantId, (tx) =>
        tx.user.findUnique({ where: { tenantId_email: { tenantId: homeTenantId, email } }, select: { id: true } }),
      );
      if (existing) action = "exists";
    }
    rows.push({ line, email, displayName, role, scope, branchSlug, homeTenantId, action, errors });
  }
  const summary = { create: 0, exists: 0, error: 0 };
  for (const r of rows) summary[r.action]++;
  return { rows, summary, canApply: rows.length > 0 && summary.error === 0 };
}

/** A fresh single-use set-password token for a user (any previous unused ones are revoked). */
export async function issuePasswordToken(prisma: PrismaClient, userId: string, tenantId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await prisma.userPasswordToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.userPasswordToken.create({
    data: { userId, tenantId, tokenHash: hashPasswordToken(token), expiresAt: new Date(Date.now() + PASSWORD_LINK_TTL_HOURS * 3600_000) },
  });
  return token;
}

export async function applyUserImport(
  prisma: PrismaClient,
  params: Parameters<typeof planUserImport>[1],
): Promise<{ plan: UserImportPlan; created: CreatedUserLink[] }> {
  const plan = await planUserImport(prisma, params);
  if (!plan.canApply) return { plan, created: [] };
  const created: CreatedUserLink[] = [];
  for (const row of plan.rows) {
    if (row.action !== "create") continue;
    const tenantId = row.homeTenantId!;
    const user = await withTenantContext(prisma, tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          email: row.email,
          displayName: row.displayName,
          passwordHash: null, // cannot log in until the link is used
          status: "ACTIVE",
          roles: {
            create: {
              role: row.role as (typeof ROLES)[number],
              scope: row.scope as (typeof SCOPES)[number],
              tenantIds: row.scope === "TENANT" ? [tenantId] : [],
            },
          },
        },
      }),
    );
    const token = await issuePasswordToken(prisma, user.id, tenantId);
    const slug = (await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true } })).slug;
    created.push({ email: row.email, displayName: row.displayName, branchSlug: slug, token, userId: user.id, tenantId });
  }
  return { plan, created };
}
