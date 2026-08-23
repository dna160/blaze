import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

import type { Prisma, PrismaClient } from "../generated/client/index.js";

/**
 * Per-organization messaging credentials (#40 — one WhatsApp number for all
 * branches, configured in the console rather than baked into a deployment).
 *
 * Stored on the existing `Organization.messagingConfig` JSON column, which
 * BUILD-SPEC #40 already reserved as the override seam. That column's comment
 * says "secrets injected at runtime, not stored raw" — the console flow needs
 * the secret to survive a restart, so instead of raw storage the access token
 * is sealed with AES-256-GCM under MESSAGING_CONFIG_KEY and only the sealed
 * form is persisted. Nothing that can send a message is readable from a
 * database dump alone.
 *
 * Organization, like Tenant, is deliberately outside RLS (it is the bootstrap
 * registry that resolves before any tenant context exists), so every read here
 * takes an explicit organizationId and callers must have already authorized it.
 *
 * Resolution order, per send:
 *   1. the org's saved config, when its provider is set and complete;
 *   2. the MESSAGING_PROVIDER / WHATSAPP_* environment, for deployments that
 *      configured credentials before this screen existed;
 *   3. console_log — never a hard failure, so a tenant that has not finished
 *      onboarding still gets an auditable Notification row.
 */

export type MessagingProviderName = "console_log" | "whatsapp_cloud";

export interface WhatsAppCloudCredentials {
  phoneNumberId: string;
  accessToken: string;
  businessAccountId?: string;
}

export interface ResolvedMessagingConfig {
  provider: MessagingProviderName;
  /** Present only when provider === "whatsapp_cloud". */
  whatsapp?: WhatsAppCloudCredentials;
  /** Where the credentials came from — surfaced in the console so "why is this still logging to console?" is answerable. */
  source: "organization" | "environment" | "default";
}

/** What the console may read back. Never includes the token itself. */
export interface MessagingConfigView {
  provider: MessagingProviderName;
  phoneNumberId: string | null;
  businessAccountId: string | null;
  /** Last 4 characters of the saved token, so staff can tell which one is loaded. */
  accessTokenHint: string | null;
  hasAccessToken: boolean;
  updatedAt: string | null;
  updatedByUserId: string | null;
  source: ResolvedMessagingConfig["source"];
}

interface StoredConfig {
  provider?: string;
  phoneNumberId?: string;
  businessAccountId?: string;
  accessTokenHint?: string;
  /** AES-256-GCM, "<iv-hex>:<tag-hex>:<ciphertext-hex>". */
  accessTokenSealed?: string;
  updatedAt?: string;
  updatedByUserId?: string;
}

const KEY_ENV = "MESSAGING_CONFIG_KEY";

/**
 * 32 raw bytes, supplied as 64 hex chars. Generate with
 * `openssl rand -hex 32`. Absent, the console screen refuses to SAVE a token
 * (so nothing is ever written in a form we could not read back) but reading
 * and sending still work off the environment — losing the key must not take
 * messaging down, only the ability to change it.
 */
export function messagingConfigKey(): Buffer | null {
  const raw = process.env[KEY_ENV];
  if (!raw) return null;
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error(`${KEY_ENV} must be 32 bytes as 64 hex characters (got ${key.length} bytes).`);
  }
  return key;
}

export function sealSecret(plaintext: string): string {
  const key = messagingConfigKey();
  if (!key) throw new Error(`${KEY_ENV} is not set — cannot store a messaging credential.`);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

export function openSecret(sealed: string): string | null {
  const key = messagingConfigKey();
  if (!key) return null;
  const [ivHex, tagHex, dataHex] = sealed.split(":");
  if (!ivHex || !tagHex || !dataHex) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key or tampered payload — GCM's auth tag failing is the whole point.
    return null;
  }
}

/** Constant-time compare, for the inbound-webhook verify token when that lands. */
export function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function envConfig(): ResolvedMessagingConfig | null {
  if (process.env.MESSAGING_PROVIDER !== "whatsapp_cloud") return null;
  const accessToken = process.env.WHATSAPP_CLOUD_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) return null;
  return { provider: "whatsapp_cloud", whatsapp: { phoneNumberId, accessToken }, source: "environment" };
}

function fromStored(stored: StoredConfig): ResolvedMessagingConfig | null {
  if (stored.provider !== "whatsapp_cloud") return null;
  if (!stored.phoneNumberId || !stored.accessTokenSealed) return null;
  const accessToken = openSecret(stored.accessTokenSealed);
  if (!accessToken) return null; // key missing or rotated — fall through rather than throw mid-send
  return {
    provider: "whatsapp_cloud",
    whatsapp: { phoneNumberId: stored.phoneNumberId, accessToken, businessAccountId: stored.businessAccountId },
    source: "organization",
  };
}

/** The org that owns a tenant. Both tables sit outside RLS, so this is a plain read. */
async function organizationIdForTenant(prisma: PrismaClient, tenantId: string): Promise<string | null> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { organizationId: true } });
  return tenant?.organizationId ?? null;
}

export async function readStoredConfig(prisma: PrismaClient, organizationId: string): Promise<StoredConfig> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { messagingConfig: true } });
  return ((org?.messagingConfig ?? {}) as StoredConfig) ?? {};
}

/** What actually sends a message for this tenant, and where those credentials came from. */
export async function resolveMessagingConfig(prisma: PrismaClient, tenantId: string): Promise<ResolvedMessagingConfig> {
  const organizationId = await organizationIdForTenant(prisma, tenantId);
  if (organizationId) {
    const resolved = fromStored(await readStoredConfig(prisma, organizationId));
    if (resolved) return resolved;
  }
  return envConfig() ?? { provider: "console_log", source: "default" };
}

export async function getMessagingConfigView(prisma: PrismaClient, organizationId: string): Promise<MessagingConfigView> {
  const stored = await readStoredConfig(prisma, organizationId);
  const resolved = fromStored(stored) ?? envConfig() ?? { provider: "console_log" as const, source: "default" as const };
  return {
    provider: (stored.provider as MessagingProviderName) ?? resolved.provider,
    phoneNumberId: stored.phoneNumberId ?? null,
    businessAccountId: stored.businessAccountId ?? null,
    accessTokenHint: stored.accessTokenHint ?? null,
    hasAccessToken: Boolean(stored.accessTokenSealed),
    updatedAt: stored.updatedAt ?? null,
    updatedByUserId: stored.updatedByUserId ?? null,
    source: resolved.source,
  };
}

export interface MessagingConfigUpdate {
  provider: MessagingProviderName;
  phoneNumberId?: string | null;
  businessAccountId?: string | null;
  /** Omit to keep the stored token; pass a new one to replace it. */
  accessToken?: string | null;
}

export async function saveMessagingConfig(
  prisma: PrismaClient,
  organizationId: string,
  update: MessagingConfigUpdate,
  updatedByUserId: string,
): Promise<MessagingConfigView> {
  const existing = await readStoredConfig(prisma, organizationId);
  const next: StoredConfig = {
    ...existing,
    provider: update.provider,
    phoneNumberId: update.phoneNumberId ?? undefined,
    businessAccountId: update.businessAccountId ?? undefined,
    updatedAt: new Date().toISOString(),
    updatedByUserId,
  };

  if (update.accessToken) {
    next.accessTokenSealed = sealSecret(update.accessToken);
    next.accessTokenHint = update.accessToken.slice(-4);
  }
  // Switching back to console_log keeps the sealed token, so turning WhatsApp
  // off for a weekend does not mean re-pasting a credential to turn it on.

  await prisma.organization.update({
    where: { id: organizationId },
    data: { messagingConfig: next as unknown as Prisma.InputJsonValue },
  });
  return getMessagingConfigView(prisma, organizationId);
}
