import { createHash, randomBytes } from "node:crypto";

import type { Prisma } from "../generated/client/index.js";

/**
 * Magic-link credentials (PRD v2 §9, P4). A customer-facing message
 * carries `{storefront}/m/{token}?next=/portal/...`; exchanging the token
 * issues an ordinary customer JWT, so the customer never types an OTP to
 * act on a message. Lives in @rentos/database (not apps/api) because
 * apps/worker sends invoice/reminder messages too and needs to mint the
 * same links through the same code path.
 *
 * Security shape: 32 random bytes, only the SHA-256 hash stored; 30-day
 * expiry; multi-use (the whole point is "no OTP over and over");
 * revocable; one live token per (customer, purpose) — minting a new one
 * revokes the previous. RLS scopes every lookup to the tenant the request
 * already resolved, so a token can't be probed across tenants.
 */
export const MAGIC_LINK_TTL_DAYS = 30;

export function hashAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Returns the PLAINTEXT token (to embed in a link) — the only time it's ever available. */
export async function findOrCreateCustomerAccessToken(
  tx: Prisma.TransactionClient,
  tenantId: string,
  customerId: string,
  purpose: string,
  ttlDays = MAGIC_LINK_TTL_DAYS,
): Promise<{ token: string; expiresAt: Date }> {
  // A still-valid token for the same purpose is revoked rather than reused —
  // we can't recover its plaintext (hash only), and rotating on every
  // message bounds the damage of any one link being forwarded.
  await tx.customerAccessToken.updateMany({
    where: { customerId, purpose, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  await tx.customerAccessToken.create({
    data: { tenantId, customerId, tokenHash: hashAccessToken(token), purpose, expiresAt },
  });
  return { token, expiresAt };
}

/** Validates a presented token and records the use. Returns the customer id, or null for unknown/expired/revoked. */
export async function exchangeCustomerAccessToken(tx: Prisma.TransactionClient, token: string): Promise<{ customerId: string; purpose: string } | null> {
  const record = await tx.customerAccessToken.findUnique({ where: { tokenHash: hashAccessToken(token) } });
  if (!record || record.revokedAt || record.expiresAt.getTime() < Date.now()) return null;
  await tx.customerAccessToken.update({
    where: { id: record.id },
    data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
  });
  return { customerId: record.customerId, purpose: record.purpose };
}
