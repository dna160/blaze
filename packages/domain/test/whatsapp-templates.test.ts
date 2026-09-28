import { describe, expect, it } from "vitest";

import {
  allWhatsAppTemplates,
  buildWhatsAppTemplatePayload,
  resolveWhatsAppTemplate,
  sanitizeTemplateParam,
  WhatsAppTemplateError,
} from "../src/comms/whatsapp-templates.js";

/** The variables a caller would realistically have for a given template. */
function varsFor(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((n) => [n, `value-${n}`]));
}

function bodyParams(payload: ReturnType<typeof buildWhatsAppTemplatePayload>): string[] {
  const components = (payload.template as { components: Array<Record<string, unknown>> }).components;
  const body = components.find((c) => c.type === "body") as { parameters: Array<{ text: string }> };
  return body.parameters.map((p) => p.text);
}

describe("whatsapp template registry", () => {
  it("orders parameters by the declared list, not by object insertion order", () => {
    // Deliberately reversed relative to the declared params.
    const payload = buildWhatsAppTemplatePayload("invoice_paid", "628123", {
      link: "https://example.test/m/abc",
      totalAmount: "1500000",
      invoiceNumber: "INV-1",
      customerName: "Budi",
    });
    expect(bodyParams(payload)).toEqual(["Budi", "INV-1", "1500000", "https://example.test/m/abc"]);
  });

  it("ignores variables the template does not declare", () => {
    // booking_approved's call site used to pass a raw bookingId UUID.
    const payload = buildWhatsAppTemplatePayload("booking_approved", "628123", {
      customerName: "Budi",
      link: "https://example.test/m/abc",
      bookingId: "3f8c1f2e-0000-4000-8000-000000000000",
    });
    expect(bodyParams(payload)).toEqual(["Budi", "https://example.test/m/abc"]);
  });

  it("gives every template a stable arity regardless of caller", () => {
    for (const spec of allWhatsAppTemplates()) {
      const payload = buildWhatsAppTemplatePayload(
        spec.metaName === "invoice_reminder" ? "invoice_reminder_h7" : spec.metaName,
        "628123",
        varsFor(spec.params),
      );
      expect(bodyParams(payload)).toHaveLength(spec.params.length);
    }
  });

  it("declares a {{n}} placeholder for each parameter and no more", () => {
    for (const spec of allWhatsAppTemplates()) {
      if (spec.authentication) continue; // Meta owns the body text for these.
      const used = new Set([...spec.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
      const expected = new Set(spec.params.map((_, i) => i + 1));
      expect([...used].sort((a, b) => a - b), `${spec.metaName} placeholders`).toEqual(
        [...expected].sort((a, b) => a - b),
      );
    }
  });

  it("never starts or ends a body on a bare placeholder (Meta rejects those)", () => {
    for (const spec of allWhatsAppTemplates()) {
      if (spec.authentication) continue;
      expect(spec.body.trimStart().startsWith("{{"), `${spec.metaName} starts on a variable`).toBe(false);
      expect(spec.body.trimEnd().endsWith("}}"), `${spec.metaName} ends on a variable`).toBe(false);
    }
  });

  it("throws on a missing parameter rather than shifting the rest into its slot", () => {
    expect(() =>
      buildWhatsAppTemplatePayload("invoice_paid", "628123", { customerName: "Budi", invoiceNumber: "INV-1" }),
    ).toThrow(WhatsAppTemplateError);
  });

  it("treats an empty string as missing", () => {
    // booking_received used to send `position: ""` on the non-waitlist branch.
    expect(() =>
      buildWhatsAppTemplatePayload("booking_waitlisted", "628123", {
        customerName: "Budi",
        assetTypeName: "3x3",
        locationName: "Kebon Jeruk",
        position: "   ",
        link: "https://example.test/m/abc",
      }),
    ).toThrow(/position/);
  });

  it("throws on an unregistered template key", () => {
    expect(() => buildWhatsAppTemplatePayload("not_a_template", "628123", {})).toThrow(/not_a_template/);
  });

  it("collapses whitespace Meta would reject inside a parameter", () => {
    expect(sanitizeTemplateParam("Budi\nSantoso")).toBe("Budi Santoso");
    expect(sanitizeTemplateParam("a\t\tb")).toBe("a b");
    expect(sanitizeTemplateParam("too     many")).toBe("too many");
    const payload = buildWhatsAppTemplatePayload("booking_rejected", "628123", {
      customerName: "Budi",
      reason: "KTP tidak terbaca.\n\nMohon unggah ulang.",
    });
    expect(bodyParams(payload)[1]).toBe("KTP tidak terbaca. Mohon unggah ulang.");
  });

  describe("dunning ladder's dynamic keys", () => {
    it("maps any day count onto one Meta template, with the day as a parameter", () => {
      for (const days of [1, 3, 5, 7, 21]) {
        const resolved = resolveWhatsAppTemplate(`invoice_reminder_h${days}`);
        expect(resolved?.spec.metaName).toBe("invoice_reminder");
        expect(resolved?.derived.daysUntilDue).toBe(String(days));
      }
      expect(resolveWhatsAppTemplate("invoice_overdue_d3")?.spec.metaName).toBe("invoice_overdue");
    });

    it("derives the day count even when the caller omits it", () => {
      const payload = buildWhatsAppTemplatePayload("invoice_overdue_d3", "628123", {
        customerName: "Budi",
        invoiceNumber: "INV-1",
        link: "https://example.test/m/abc",
      });
      expect(bodyParams(payload)).toEqual(["Budi", "INV-1", "3", "https://example.test/m/abc"]);
    });

    it("routes the branch-admin leg to its own template", () => {
      expect(resolveWhatsAppTemplate("invoice_reminder_h7_admin")?.spec.metaName).toBe("invoice_reminder_admin");
      expect(resolveWhatsAppTemplate("invoice_overdue_d3_admin")?.spec.metaName).toBe("invoice_overdue_admin");
    });
  });

  describe("authentication category", () => {
    it("sends the OTP in both the body and the copy-code button", () => {
      const payload = buildWhatsAppTemplatePayload("otp_code", "628123", { code: "483920" });
      const components = (payload.template as { components: Array<Record<string, unknown>> }).components;
      expect(components).toHaveLength(2);
      expect(bodyParams(payload)).toEqual(["483920"]);
      expect(components[1]).toEqual({
        type: "button",
        sub_type: "copy_code",
        index: "0",
        parameters: [{ type: "coupon_code", coupon_code: "483920" }],
      });
    });

    it("is the only AUTHENTICATION template — everything else is UTILITY", () => {
      const auth = allWhatsAppTemplates().filter((t) => t.category === "AUTHENTICATION");
      expect(auth.map((t) => t.metaName)).toEqual(["otp_code"]);
      expect(allWhatsAppTemplates().every((t) => t.category !== "MARKETING")).toBe(true);
    });
  });

  it("gives each Meta name exactly one spec", () => {
    const names = allWhatsAppTemplates().map((t) => t.metaName);
    expect(new Set(names).size).toBe(names.length);
  });
});
