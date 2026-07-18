import { createHash, randomBytes } from "node:crypto";

const KEY_PREFIX = "rok_";

/**
 * SHA-256, not bcrypt: API keys are high-entropy random secrets, not
 * low-entropy human-chosen passwords, so there's nothing for a slow hash
 * to defend against here and it would just add CPU cost to every
 * external-API request.
 */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function generateApiKey(): { plaintext: string; keyPrefix: string; keyHash: string } {
  const plaintext = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { plaintext, keyPrefix: plaintext.slice(0, 12), keyHash: hashApiKey(plaintext) };
}
