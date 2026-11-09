import { describe, expect, it } from "vitest";

import { DEFAULT_AUTO_REPLY_TEXT, renderAutoReply, type BranchContact } from "../src/comms/auto-reply.js";

// Illustrative CS numbers — +62 811-1877-838 is City Storage's SYSTEM number and never a CS contact.
const kbj: BranchContact = { id: "kbj", name: "City Storage Kebon Jeruk", whatsapp: "+62 812-0000-001", phone: "021-300 67838" };
const stb: BranchContact = { id: "stb", name: "City Storage Setiabudi", whatsapp: "+62 811-0000-000", phone: null };

describe("renderAutoReply", () => {
  it("points a customer of one branch at that branch's CS", () => {
    const text = renderAutoReply(DEFAULT_AUTO_REPLY_TEXT, [kbj, stb], "stb");
    expect(text).toContain("hubungi CS City Storage Setiabudi: WA +62 811-0000-000.");
  });

  it("uses the only branch when the organization has one, even for an unknown number", () => {
    expect(renderAutoReply("{branchName} {branchWhatsapp} {branchPhone}", [kbj], null)).toBe(
      "City Storage Kebon Jeruk +62 812-0000-001 021-300 67838",
    );
  });

  it("lists every branch for an unknown number when there are several", () => {
    const text = renderAutoReply("Hubungi:\n{allBranches}", [kbj, stb], null);
    expect(text).toBe("Hubungi:\nCity Storage Kebon Jeruk: WA +62 812-0000-001 · Tel 021-300 67838\nCity Storage Setiabudi: WA +62 811-0000-000");
  });

  it("leaves text without placeholders untouched", () => {
    expect(renderAutoReply("Terima kasih!", [kbj], null)).toBe("Terima kasih!");
  });

  it("falls back to phone, then email, when a branch has no CS WhatsApp", () => {
    const noWa: BranchContact = { id: "x", name: "City Storage Kebon Jeruk", whatsapp: null, phone: "+62 21 3006 7838", email: "cs@citystorage.co.id" };
    expect(renderAutoReply("{branchContact}", [noWa], null)).toBe("Tel +62 21 3006 7838");
    expect(renderAutoReply("{branchContact}", [{ ...noWa, phone: null }], null)).toBe("cs@citystorage.co.id");
  });
});
