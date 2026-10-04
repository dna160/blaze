import { describe, expect, it } from "vitest";

import {
  CUSTOMER_SERVICE_WINDOW_MS,
  isReplyWindowOpen,
  messageDirection,
  messageKind,
  normalizePhone,
  phoneCandidates,
  replyWindowClosesAt,
} from "../src/messaging.js";

describe("phone normalisation", () => {
  it("collapses the spellings Meta and the customer record disagree on", () => {
    // Meta sends 6281…, customers are stored +6281…. One conversation.
    expect(normalizePhone("+6281100000001")).toBe("6281100000001");
    expect(normalizePhone("6281100000001")).toBe("6281100000001");
    expect(normalizePhone("+62 811-0000-0001")).toBe("6281100000001");
    expect(normalizePhone("(+62) 811 0000 0001")).toBe("6281100000001");
  });

  it("offers both spellings for matching stored customer phones", () => {
    expect(phoneCandidates("6281100000001")).toEqual(["6281100000001", "+6281100000001"]);
    expect(phoneCandidates("+6281100000001")).toEqual(["6281100000001", "+6281100000001"]);
  });
});

describe("the 24-hour customer service window", () => {
  const now = new Date("2026-10-04T12:00:00.000Z");

  it("is closed when the customer has never written in", () => {
    expect(isReplyWindowOpen(null, now)).toBe(false);
    expect(replyWindowClosesAt(null)).toBeNull();
  });

  it("is open just inside 24 hours", () => {
    const lastInbound = new Date(now.getTime() - CUSTOMER_SERVICE_WINDOW_MS + 1000);
    expect(isReplyWindowOpen(lastInbound, now)).toBe(true);
  });

  it("is closed at exactly 24 hours — the boundary belongs to the closed side", () => {
    const lastInbound = new Date(now.getTime() - CUSTOMER_SERVICE_WINDOW_MS);
    expect(isReplyWindowOpen(lastInbound, now)).toBe(false);
  });

  it("is closed past 24 hours", () => {
    const lastInbound = new Date(now.getTime() - CUSTOMER_SERVICE_WINDOW_MS - 1);
    expect(isReplyWindowOpen(lastInbound, now)).toBe(false);
  });

  it("accepts the ISO strings the API actually carries", () => {
    const lastInbound = new Date(now.getTime() - 60_000).toISOString();
    expect(isReplyWindowOpen(lastInbound, now)).toBe(true);
  });

  it("closes exactly 24 hours after the last inbound", () => {
    const lastInbound = new Date("2026-10-04T09:30:00.000Z");
    expect(replyWindowClosesAt(lastInbound)?.toISOString()).toBe("2026-10-05T09:30:00.000Z");
  });
});

describe("direction and kind derivation", () => {
  it("treats only webhook-written rows as inbound", () => {
    expect(messageDirection("inbound_message")).toBe("in");
    for (const key of ["auto_reply", "agent_reply", "booking_received", "otp_code"]) {
      expect(messageDirection(key)).toBe("out");
    }
  });

  it("distinguishes an inbound attachment from inbound text", () => {
    expect(messageKind("inbound_message", { text: "halo" })).toBe("text");
    expect(messageKind("inbound_message", { text: "(image)", mediaId: "123" })).toBe("media");
  });

  it("labels our own sends by how they were produced", () => {
    expect(messageKind("auto_reply", {})).toBe("auto_reply");
    expect(messageKind("agent_reply", {})).toBe("text");
    // Anything else on the pair is a template send — booking confirmations,
    // invoices, dunning — and the thread captions it with its key.
    expect(messageKind("contract_proforma_ready", {})).toBe("template");
    expect(messageKind("invoice_reminder_h7", {})).toBe("template");
  });
});
