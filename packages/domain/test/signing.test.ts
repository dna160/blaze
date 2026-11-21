import { describe, expect, it } from "vitest";

import {
  customerSigningOption,
  daysUntilSignDeadline,
  decideSigning,
  offlineSignDeadline,
  offlineSignStep,
  resolveDefaultSignMethod,
  resolveOfflineSignDays,
  type SigningAction,
  type SigningContext,
} from "../src/documents/signing.js";

const base: SigningContext = { signMethod: "ONLINE", actor: "CUSTOMER", esignConfigured: false, alreadySigned: false, esignPending: false };

describe("decideSigning (PRD go-live 2 §5.3)", () => {
  it("never sends an uploaded scan to the e-sign provider — whatever is configured", () => {
    for (const signMethod of ["ONLINE", "OFFLINE"] as const) {
      for (const esignConfigured of [true, false]) {
        const d = decideSigning("UPLOAD_SCAN", { ...base, actor: "STAFF", signMethod, esignConfigured });
        expect(d.allowed, `${signMethod} esign=${esignConfigured}`).toBe(true);
        expect(d.sendsToEsignProvider, `${signMethod} esign=${esignConfigured}`).toBe(false);
      }
    }
  });

  it("only the ESIGN action ever reaches the provider, and only when it is allowed", () => {
    const actions: SigningAction[] = ["SIGNATURE_PAD", "ESIGN", "UPLOAD_SCAN"];
    for (const action of actions) {
      for (const actor of ["CUSTOMER", "STAFF"] as const) {
        for (const signMethod of ["ONLINE", "OFFLINE"] as const) {
          for (const esignConfigured of [true, false]) {
            const d = decideSigning(action, { ...base, actor, signMethod, esignConfigured });
            if (d.sendsToEsignProvider) {
              expect(action).toBe("ESIGN");
              expect(d.allowed).toBe(true);
              expect(signMethod).toBe("ONLINE");
              expect(esignConfigured).toBe(true);
            }
          }
        }
      }
    }
  });

  it("lets only staff upload a paper contract", () => {
    expect(decideSigning("UPLOAD_SCAN", { ...base, actor: "CUSTOMER" }).allowed).toBe(false);
    expect(decideSigning("UPLOAD_SCAN", { ...base, actor: "STAFF" }).allowed).toBe(true);
  });

  it("shows the customer exactly one way to sign", () => {
    // Online, no provider yet: the signature pad.
    expect(customerSigningOption({ signMethod: "ONLINE", esignConfigured: false })).toBe("SIGNATURE_PAD");
    expect(decideSigning("SIGNATURE_PAD", base).allowed).toBe(true);
    expect(decideSigning("ESIGN", base).allowed).toBe(false);
    // Online with Privy configured: the provider, not the pad.
    expect(customerSigningOption({ signMethod: "ONLINE", esignConfigured: true })).toBe("ESIGN");
    expect(decideSigning("SIGNATURE_PAD", { ...base, esignConfigured: true }).allowed).toBe(false);
    expect(decideSigning("ESIGN", { ...base, esignConfigured: true })).toEqual({ allowed: true, sendsToEsignProvider: true });
    // Offline: neither — the customer comes to the office.
    expect(customerSigningOption({ signMethod: "OFFLINE", esignConfigured: true })).toBe("AT_OFFICE");
    expect(decideSigning("SIGNATURE_PAD", { ...base, signMethod: "OFFLINE" }).allowed).toBe(false);
    expect(decideSigning("ESIGN", { ...base, signMethod: "OFFLINE", esignConfigured: true }).allowed).toBe(false);
  });

  it("lets staff use the pad with the customer at the counter", () => {
    expect(decideSigning("SIGNATURE_PAD", { ...base, actor: "STAFF", signMethod: "OFFLINE" }).allowed).toBe(true);
  });

  it("refuses everything on a signed contract or one waiting on its e-signature", () => {
    for (const action of ["SIGNATURE_PAD", "ESIGN", "UPLOAD_SCAN"] as const) {
      expect(decideSigning(action, { ...base, actor: "STAFF", esignConfigured: true, alreadySigned: true }).allowed).toBe(false);
      expect(decideSigning(action, { ...base, actor: "STAFF", esignConfigured: true, esignPending: true }).allowed).toBe(false);
    }
  });
});

describe("offline signing deadline", () => {
  const generated = new Date("2026-11-20T03:00:00.000Z");

  it("defaults to 7 days and to ONLINE, both overridable per branch", () => {
    expect(resolveOfflineSignDays({})).toBe(7);
    expect(resolveOfflineSignDays({ offlineSignDays: 10 })).toBe(10);
    expect(resolveOfflineSignDays({ offlineSignDays: 0 })).toBe(7);
    expect(resolveOfflineSignDays({ offlineSignDays: "5" })).toBe(7);
    expect(resolveDefaultSignMethod(null)).toBe("ONLINE");
    expect(resolveDefaultSignMethod({ defaultSignMethod: "OFFLINE" })).toBe("OFFLINE");
    expect(offlineSignDeadline(generated, 7).toISOString()).toBe("2026-11-27T03:00:00.000Z");
  });

  it("reminds 3 days and 1 day before, then lapses", () => {
    const deadline = offlineSignDeadline(generated, 7);
    const at = (iso: string) => offlineSignStep(deadline, new Date(iso));
    expect(at("2026-11-21T02:00:00.000Z")).toEqual({ kind: "wait" }); // 6 days and a bit
    expect(at("2026-11-24T02:00:00.000Z")).toEqual({ kind: "wait" }); // 4 days left (rounded up)
    expect(at("2026-11-24T04:00:00.000Z")).toEqual({ kind: "remind", daysLeft: 3 });
    expect(at("2026-11-25T04:00:00.000Z")).toEqual({ kind: "wait" });
    expect(at("2026-11-26T04:00:00.000Z")).toEqual({ kind: "remind", daysLeft: 1 });
    expect(at("2026-11-27T03:00:00.000Z")).toEqual({ kind: "lapse" });
    expect(at("2026-12-05T00:00:00.000Z")).toEqual({ kind: "lapse" });
    expect(daysUntilSignDeadline(deadline, new Date("2026-11-26T04:00:00.000Z"))).toBe(1);
  });
});
