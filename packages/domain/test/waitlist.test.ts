import { describe, expect, it } from "vitest";

import {
  nextArmedEntry,
  resequencePositions,
  computeFireExpiry,
  isFireExpired,
  type WaitlistEntryLike,
} from "../src/waitlist/waitlist-rules.js";

function entry(id: string, position: number, status: WaitlistEntryLike["status"], extra: Partial<WaitlistEntryLike> = {}): WaitlistEntryLike {
  return { id, position, status, ...extra };
}

describe("Waitlist rules (C5)", () => {
  it("fires the lowest-position ARMED entry", () => {
    const entries = [entry("c", 3, "ARMED"), entry("a", 1, "ARMED"), entry("b", 2, "ARMED")];
    expect(nextArmedEntry(entries)?.id).toBe("a");
  });

  it("skips non-armed entries when choosing who fires next", () => {
    const entries = [entry("a", 1, "FIRED"), entry("b", 2, "EXPIRED"), entry("c", 3, "ARMED")];
    expect(nextArmedEntry(entries)?.id).toBe("c");
  });

  it("returns null when nobody is armed", () => {
    expect(nextArmedEntry([entry("a", 1, "CONVERTED")])).toBeNull();
  });

  it("resequences positions to a contiguous 1..n after the head leaves", () => {
    // 'a' (pos 1) fired and left the armed set; b/c/d should shift up.
    const entries = [
      entry("a", 1, "FIRED"),
      entry("b", 2, "ARMED"),
      entry("c", 3, "ARMED"),
      entry("d", 4, "ARMED"),
    ];
    const changes = resequencePositions(entries);
    expect(changes.get("b")).toBe(1);
    expect(changes.get("c")).toBe(2);
    expect(changes.get("d")).toBe(3);
  });

  it("payment TTL: a fired entry expires after the TTL window (C5 rule 3)", () => {
    const firedAt = new Date("2026-08-09T10:00:00Z");
    const expiresAt = computeFireExpiry(firedAt, 24);
    expect(expiresAt.toISOString()).toBe("2026-08-10T10:00:00.000Z");

    const fired = entry("x", 1, "FIRED", { firedAt, expiresAt });
    expect(isFireExpired(fired, new Date("2026-08-10T09:59:00Z"))).toBe(false);
    expect(isFireExpired(fired, new Date("2026-08-10T10:00:01Z"))).toBe(true);
  });

  it("an armed (not yet fired) entry never counts as expired", () => {
    expect(isFireExpired(entry("x", 1, "ARMED"), new Date())).toBe(false);
  });
});
