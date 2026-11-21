import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { allowlistPermits, normalizeAllowlistNumber, recipientPhoneKey } from "../src/messaging-pause.js";

/**
 * PRD go-live 2 §8.1 — the test allowlist. The database-backed behaviour
 * (suppress, record the code) is exercised end to end against the API; these
 * are the pure rules it rests on.
 */
describe("recipientPhoneKey", () => {
  it("reads every common spelling of one Indonesian number as the same recipient", () => {
    const spellings = ["+628111877838", "628111877838", "08111877838", "+62 811-1877-838", "(0811) 1877 838", " +62.811.1877.838 "];
    expect(new Set(spellings.map(recipientPhoneKey))).toEqual(new Set(["628111877838"]));
  });

  it("is null for anything that is not a phone number", () => {
    expect(recipientPhoneKey("finance@citystorage.co.id")).toBeNull();
    expect(recipientPhoneKey("")).toBeNull();
    expect(recipientPhoneKey(null)).toBeNull();
    expect(recipientPhoneKey("12345")).toBeNull();
    expect(recipientPhoneKey("n/a")).toBeNull();
  });

  it("keeps a non-Indonesian number as it is", () => {
    expect(recipientPhoneKey("+6591234567")).toBe("6591234567");
  });
});

describe("normalizeAllowlistNumber", () => {
  it("stores E.164 with the plus", () => {
    expect(normalizeAllowlistNumber("0811-1877-838")).toBe("+628111877838");
    expect(normalizeAllowlistNumber("not a number")).toBeNull();
  });
});

describe("allowlistPermits", () => {
  const two = { enabled: true, numbers: ["+628111877838", "+6281234567890"] };

  it("lets everything through while the toggle is off", () => {
    expect(allowlistPermits({ enabled: false, numbers: [] }, "+6289999999999")).toBe(true);
    expect(allowlistPermits({ enabled: false, numbers: [] }, "someone@example.com")).toBe(true);
  });

  it("lets only listed numbers through while it is on, in any spelling", () => {
    expect(allowlistPermits(two, "+628111877838")).toBe(true);
    expect(allowlistPermits(two, "08111877838")).toBe(true);
    expect(allowlistPermits(two, "6281234567890")).toBe(true);
    expect(allowlistPermits(two, "+6289999999999")).toBe(false);
  });

  it("never matches a number by its tail", () => {
    // 0811… is on the list; a longer number that merely ends the same is someone else.
    expect(allowlistPermits(two, "+6288111877838")).toBe(false);
    expect(allowlistPermits(two, "+62811187783")).toBe(false);
  });

  it("holds back e-mail and a missing recipient: the list holds phone numbers", () => {
    expect(allowlistPermits(two, "customer@example.com")).toBe(false);
    expect(allowlistPermits(two, null)).toBe(false);
    expect(allowlistPermits(two, "")).toBe(false);
  });

  it("sends nothing when the list is empty — failing closed", () => {
    expect(allowlistPermits({ enabled: true, numbers: [] }, "+628111877838")).toBe(false);
  });
});

/**
 * "A sender cannot ask 'may I send?' without saying to whom." TypeScript makes
 * the recipient argument required; this keeps anyone from satisfying it with a
 * literal null at a call site that does have a recipient.
 */
describe("every sender tells outboundBlock who the message is for", () => {
  const ROOT = path.resolve(__dirname, "../../..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
    });
  const calls = ["apps/api/src", "apps/worker/src"]
    .flatMap((d) => walk(path.join(ROOT, d)))
    .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/outboundBlock\(([^)]*)\)/g)].map((m) => ({ file: path.relative(ROOT, file), args: m[1]!.split(",").map((a) => a.trim()) })));

  it("finds the four senders", () => {
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it.each(calls.map((c) => [c.file, c.args] as const))("%s passes a recipient", (_file, args) => {
    expect(args).toHaveLength(3);
    expect(args[2]).not.toBe("null");
    expect(args[2]).not.toBe("undefined");
  });
});
