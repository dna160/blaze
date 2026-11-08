import "reflect-metadata";

import path from "node:path";

import { createPrismaClient, type PrismaClient } from "@rentos/database";

import { LocalDiskStorageProvider } from "../../src/storage/providers/local-disk.provider.js";
import { S3StorageProvider } from "../../src/storage/providers/s3.provider.js";
import type { StorageProvider } from "../../src/storage/storage-provider.interface.js";

/**
 * Shared plumbing for the go-live CLIs (PRD go-live §4.4, §5.3, §10). They
 * run as the OWNER role (DATABASE_URL), like migrations and the seed: a
 * one-off operator action, not a request. Every tenant-table write still goes
 * through withTenantContext inside the engines.
 */

export function args(argv = process.argv.slice(2)) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

/** pnpm runs these from apps/api; a relative --file/--dir is meant relative to where the operator typed it. */
export function userPath(p: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

export function ownerClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (the owner/migrator role) is required.");
  return createPrismaClient(url);
}

export function storage(): StorageProvider {
  return process.env.STORAGE_PROVIDER === "s3" ? new S3StorageProvider() : new LocalDiskStorageProvider();
}

export async function tenantBySlug(prisma: PrismaClient, slug: string) {
  const tenant = await prisma.tenant.findUnique({ where: { slug }, select: { id: true, slug: true, name: true, organizationId: true } });
  if (!tenant) throw new Error(`No tenant with slug "${slug}".`);
  return tenant;
}

export function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}
