import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { alignContractTerms, parseContractTerms } from "../src/documents/contract-terms.js";

const md = readFileSync(path.resolve(__dirname, "../../database/prisma/data/kebon-jeruk/contract-terms-id-en.md"), "utf8");

describe("parseContractTerms (City Storage T&C, data pack)", () => {
  const terms = parseContractTerms(md);

  it("finds articles I–X in both languages", () => {
    expect(terms.id.articles).toHaveLength(10);
    expect(terms.en.articles).toHaveLength(10);
    expect(terms.id.articles[0]!.heading).toBe("I. DEFINISI.");
    expect(terms.en.articles[9]!.heading).toBe("X. CLOSING.");
  });

  it("keeps the point numbering the cross-references rely on (II.8 overtime fee, II has 14 points)", () => {
    const ii = terms.id.articles[1]!;
    expect(ii.points).toHaveLength(14);
    expect(ii.points[7]).toMatch(/^8\. .*Rp\.50\.000/);
  });

  it("keeps an article's unnumbered lead-in separate from its points", () => {
    expect(terms.id.articles[2]!.intro).toMatch(/^Dalam sewa-menyewa/);
    expect(terms.id.articles[2]!.points[0]).toMatch(/^1\. /);
  });

  it("pairs every article point by point", () => {
    for (const a of alignContractTerms(terms)) {
      expect(a.id?.points.length).toBe(a.en?.points.length);
    }
  });

  it("reads the signatory declaration as Indonesian/English pairs without the form's SIGN labels", () => {
    expect(terms.declaration).toHaveLength(3);
    expect(terms.declaration[0]!.id).toMatch(/^Dengan menandatangani/);
    expect(terms.declaration[0]!.en).toMatch(/^By signing/);
    expect(terms.declaration[2]!.id).toMatch(/^2\. Pemberi sewa/);
    expect(JSON.stringify(terms.declaration)).not.toMatch(/"SIGN"|Signature"/);
  });
});
