import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../generated/client/index.js";
import { getMessagingConfigView, resolveMessagingConfig } from "../src/messaging-config.js";
import { WaBridgeError, waBridgeSendText } from "../src/wa-bridge.js";

const ORG = "org-1";
const TENANT = "tenant-1";

/** Just the two reads resolveMessagingConfig makes; both tables sit outside RLS. */
function fakePrisma(messagingConfig: Record<string, unknown>): PrismaClient {
  return {
    tenant: { findUnique: async () => ({ organizationId: ORG }) },
    organization: { findUnique: async () => ({ messagingConfig }) },
  } as unknown as PrismaClient;
}

const ENV_KEYS = ["WA_BRIDGE_URL", "WA_BRIDGE_TOKEN", "MESSAGING_PROVIDER"] as const;

describe("whatsapp_linked resolution", () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  beforeEach(() => {
    process.env.WA_BRIDGE_URL = "http://wa-bridge:4200/";
    process.env.WA_BRIDGE_TOKEN = "t".repeat(40);
    delete process.env.MESSAGING_PROVIDER;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("addresses the organization's own instance on the deployment's bridge", async () => {
    const config = await resolveMessagingConfig(fakePrisma({ provider: "whatsapp_linked" }), TENANT);
    expect(config).toEqual({
      provider: "whatsapp_linked",
      linked: { baseUrl: "http://wa-bridge:4200", token: "t".repeat(40), instanceId: ORG },
      source: "organization",
    });
  });

  it("falls back to console_log, not a throw, when the bridge is not configured", async () => {
    delete process.env.WA_BRIDGE_URL;
    const config = await resolveMessagingConfig(fakePrisma({ provider: "whatsapp_linked" }), TENANT);
    expect(config.provider).toBe("console_log");
    const view = await getMessagingConfigView(fakePrisma({ provider: "whatsapp_linked" }), ORG);
    expect(view.linkedBridgeConfigured).toBe(false);
  });

  it("can be chosen deployment-wide with MESSAGING_PROVIDER", async () => {
    process.env.MESSAGING_PROVIDER = "whatsapp_linked";
    const config = await resolveMessagingConfig(fakePrisma({}), TENANT);
    expect(config.provider).toBe("whatsapp_linked");
    expect(config.source).toBe("environment");
    expect(config.linked?.instanceId).toBe(ORG);
  });
});

describe("waBridgeSendText", () => {
  const conn = { baseUrl: "http://wa-bridge:4200", token: "secret", instanceId: ORG };
  afterEach(() => vi.unstubAllGlobals());

  it("posts the text to the instance with the bearer token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "3EB0ABC" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(waBridgeSendText(conn, "+6281100000001", "Halo")).resolves.toEqual({ id: "3EB0ABC" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://wa-bridge:4200/instances/${ORG}/send`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body as string)).toEqual({ to: "+6281100000001", text: "Halo" });
  });

  it("keeps the bridge's channel-wide verdict on a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "not linked", code: "not_paired", channelWide: true }), { status: 409 })),
    );
    const err = await waBridgeSendText(conn, "+62811", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaBridgeError);
    expect(err).toMatchObject({ status: 409, code: "not_paired", channelWide: true, message: "not linked" });
  });

  it("treats a per-recipient refusal as not channel-wide", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "+62811 is not registered on WhatsApp.", code: "not_on_whatsapp", channelWide: false }), { status: 422 })),
    );
    await expect(waBridgeSendText(conn, "+62811", "x")).rejects.toMatchObject({ code: "not_on_whatsapp", channelWide: false });
  });

  it("reports an unreachable bridge as channel-wide", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(waBridgeSendText(conn, "+62811", "x")).rejects.toMatchObject({ code: "unreachable", channelWide: true });
  });
});
