import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_AUTO_REPLY_TEXT } from "../src/comms/auto-reply.js";
import {
  copyDeckEntries,
  copyDeckProblems,
  FORBIDDEN_CUSTOMER_WORDING,
  renderCopyDeckMarkdown,
  templateVariables,
  UNFILLED_PATTERNS,
} from "../src/comms/copy-deck.js";
import { messageTemplateKeys, renderMessage } from "../src/comms/templates.js";

/**
 * PRD go-live 2 §8.3 — the wording City Storage reviews, and the rules it must
 * keep. Everything iterates `messageTemplateKeys()`, so a template added to
 * templates.ts is covered here (and appears in the deck) without an edit.
 */
describe("message wording", () => {
  const entries = copyDeckEntries();

  it("covers every template key, the dunning families and the auto-reply", () => {
    const keys = entries.map((e) => e.key);
    for (const key of messageTemplateKeys()) expect(keys).toContain(key);
    expect(keys).toEqual(expect.arrayContaining(["invoice_reminder_h7", "invoice_overdue_d3", "invoice_reminder_h7_admin", "invoice_overdue_d3_admin", "auto_reply"]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(entries.map((e) => [e.key, e] as const))("%s has real copy in both languages", (_key, e) => {
    // An unknown key falls through to raw "name: value" lines with the key as its subject.
    expect(e.subject, "a key with no template").not.toBe(e.key);
    expect(e.text.trim().length).toBeGreaterThan(20);
    // Indonesian and English: at least two sentences/lines of wording.
    expect(e.text.split("\n").filter((l) => l.trim()).length).toBeGreaterThanOrEqual(2);
  });

  it.each(entries.map((e) => [e.key, e] as const))("%s leaves no placeholder unfilled", (_key, e) => {
    const body = `${e.subject ?? ""}\n${e.text}`;
    for (const { pattern, why } of UNFILLED_PATTERNS) expect(body, why).not.toMatch(pattern);
  });

  it.each(entries.filter((e) => e.audience === "customer").map((e) => [e.key, e] as const))(
    "%s never names the demo tenant or the product's internal name to a customer",
    (_key, e) => {
      const body = `${e.subject ?? ""}\n${e.text}`;
      for (const { pattern, why } of FORBIDDEN_CUSTOMER_WORDING) expect(body, why).not.toMatch(pattern);
      expect(body).not.toMatch(/gudang\s*aman/i);
      expect(body).not.toMatch(/rentos/i);
    },
  );

  it("never names the demo tenant anywhere, staff copy included", () => {
    for (const e of entries) expect(`${e.subject ?? ""}\n${e.text}`).not.toMatch(/gudang\s*aman/i);
    expect(DEFAULT_AUTO_REPLY_TEXT).not.toMatch(/gudang\s*aman|rentos/i);
  });

  it("stays clean when a variable is missing at send time", () => {
    // A caller that forgets a variable must produce a gap, never the word "undefined".
    for (const key of messageTemplateKeys()) {
      const { subject, text } = renderMessage(key, {});
      expect(`${subject}\n${text}`, key).not.toMatch(/undefined|null|\[object /);
    }
  });

  it("finds the variables each template reads", () => {
    expect(templateVariables("booking_approved").sort()).toEqual(["customerName", "link"]);
    expect(templateVariables("connection_test")).toEqual([]);
    expect(templateVariables("invoice_overdue_d3")).toEqual(expect.arrayContaining(["invoiceNumber", "daysOverdue", "link"]));
  });

  it("reports nothing wrong with the deck as it stands", () => {
    expect(copyDeckProblems()).toEqual([]);
  });

  it("flags a saved auto-reply that still carries the demo tenant's name", () => {
    const problems = copyDeckProblems({ autoReplyText: "Halo dari Gudang Aman! Hubungi CS {branchName}." });
    expect(problems.join("\n")).toMatch(/auto_reply: mentions .*Gudang Aman/);
  });
});

describe("the copy deck file", () => {
  const markdown = renderCopyDeckMarkdown();

  it("is one numbered list with a blank Change line under every message", () => {
    const numbered = markdown.split("\n").filter((l) => /^\d+\. \*\*`/.test(l));
    expect(numbered).toHaveLength(copyDeckEntries().length);
    expect(numbered.map((l) => Number(l.split(".")[0]))).toEqual(numbered.map((_, i) => i + 1));
    const changeLines = markdown.split("\n").filter((l) => l.trim() === "**Perubahan / Change:**");
    expect(changeLines).toHaveLength(numbered.length);
  });

  it("matches docs/COPY-whatsapp-messages.md — regenerate with `pnpm wa:templates copy --format md`", () => {
    const committed = readFileSync(path.resolve(__dirname, "../../../docs/COPY-whatsapp-messages.md"), "utf8");
    expect(committed).toBe(markdown);
  });
});
