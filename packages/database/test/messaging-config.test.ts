import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { messagingConfigKey, openSecret, sealSecret, secretsMatch } from "../src/messaging-config.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("messaging credential sealing", () => {
  const original = process.env.MESSAGING_CONFIG_KEY;
  beforeEach(() => {
    process.env.MESSAGING_CONFIG_KEY = KEY_A;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MESSAGING_CONFIG_KEY;
    else process.env.MESSAGING_CONFIG_KEY = original;
  });

  it("round-trips a token", () => {
    const token = "EAAG-a-very-long-permanent-system-user-token";
    expect(openSecret(sealSecret(token))).toBe(token);
  });

  it("never emits the plaintext in the sealed form", () => {
    const token = "EAAG-secret-token-value-1234567890";
    const sealed = sealSecret(token);
    expect(sealed).not.toContain(token);
    expect(sealed).not.toContain("secret-token-value");
  });

  it("produces a different ciphertext each time (fresh IV)", () => {
    const token = "EAAG-same-token-every-time-0000000";
    expect(sealSecret(token)).not.toBe(sealSecret(token));
  });

  it("refuses to open with the wrong key rather than returning garbage", () => {
    const sealed = sealSecret("EAAG-token-sealed-under-key-a-000000");
    process.env.MESSAGING_CONFIG_KEY = KEY_B;
    expect(openSecret(sealed)).toBeNull();
  });

  it("rejects a tampered payload (GCM auth tag)", () => {
    const sealed = sealSecret("EAAG-token-that-will-be-tampered-000");
    const [iv, tag, data] = sealed.split(":");
    const flipped = data!.slice(0, -2) + (data!.slice(-2) === "00" ? "11" : "00");
    expect(openSecret(`${iv}:${tag}:${flipped}`)).toBeNull();
  });

  it("returns null (not a throw) when no key is configured, so sends fall back instead of crashing", () => {
    const sealed = sealSecret("EAAG-token-before-key-removal-000000");
    delete process.env.MESSAGING_CONFIG_KEY;
    expect(messagingConfigKey()).toBeNull();
    expect(openSecret(sealed)).toBeNull();
  });

  it("refuses to seal without a key, so nothing is ever written unreadably", () => {
    delete process.env.MESSAGING_CONFIG_KEY;
    expect(() => sealSecret("EAAG-token-no-key-set-00000000000000")).toThrow(/MESSAGING_CONFIG_KEY/);
  });

  it("rejects a key that is not 32 bytes", () => {
    process.env.MESSAGING_CONFIG_KEY = "abcd";
    expect(() => messagingConfigKey()).toThrow(/32 bytes/);
  });

  it("rejects malformed sealed values", () => {
    expect(openSecret("not-sealed-at-all")).toBeNull();
    expect(openSecret("aa:bb")).toBeNull();
  });

  it("compares secrets without leaking length-independent timing", () => {
    expect(secretsMatch("abc123", "abc123")).toBe(true);
    expect(secretsMatch("abc123", "abc124")).toBe(false);
    expect(secretsMatch("abc", "abcdef")).toBe(false);
  });
});
