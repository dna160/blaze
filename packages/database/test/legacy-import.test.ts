import { describe, expect, it } from "vitest";

import { legacySequence, normalizeIdPhone } from "../src/imports/legacy.js";

describe("legacySequence", () => {
  it("reads the running counter of the Booqable format", () => {
    expect(legacySequence("5-2026-36-39")).toBe(39);
    expect(legacySequence("#6-2026-36-122")).toBe(122);
  });
  it("reads through a per-unit suffix", () => {
    expect(legacySequence("10-2026-44-237/STORAGE-9")).toBe(237);
  });
  it("ignores placeholders and anything not in the legacy format", () => {
    expect(legacySequence("BQ-337")).toBeNull();
    expect(legacySequence("BQ-337/STORAGE-12")).toBeNull();
    expect(legacySequence("KBJ-11-2026-36-40")).toBeNull();
  });
});

describe("normalizeIdPhone", () => {
  it("turns local spellings into +62", () => {
    expect(normalizeIdPhone("082221313459")).toBe("+6282221313459");
    expect(normalizeIdPhone("+62 822-2131-3459")).toBe("+6282221313459");
  });
});
