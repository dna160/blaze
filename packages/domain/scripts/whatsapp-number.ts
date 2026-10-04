#!/usr/bin/env node
/**
 * Get a phone number onto the WhatsApp Cloud API, and say plainly why not when
 * it will not go.
 *
 *   pnpm wa:number list                      # every WABA and number this token can reach
 *   pnpm wa:number request-code <numberId>   # send the SMS verification code
 *   pnpm wa:number verify <numberId> <code>  # confirm the 6 digits
 *   pnpm wa:number register <numberId> <pin> # register on the Cloud API
 *   pnpm wa:number status <numberId>         # platform, status, verification
 *
 * Credentials: WHATSAPP_CLOUD_TOKEN (or --token). `list` additionally uses
 * WHATSAPP_BUSINESS_ID (or --business) when it cannot discover one.
 *
 * Adding a number to a WABA in the first place is NOT here, because it is not
 * available to a direct business over the API — `POST /{waba}/phone_numbers`
 * requires Tech Provider access. Add the number in WhatsApp Manager, then use
 * this for everything after.
 */
import { describeGraphError, graphGet, graphPost, tokenFrom } from "./graph.js";

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

interface PhoneNumber {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  status?: string;
  platform_type?: string;
  code_verification_status?: string;
}

function describeNumber(p: PhoneNumber, indent = "    "): void {
  console.log(`${indent}${p.id}  ${p.display_phone_number ?? ""}  ${p.verified_name ?? ""}`);
  console.log(
    `${indent}  platform: ${p.platform_type ?? "?"}   status: ${p.status ?? "?"}   verification: ${p.code_verification_status ?? "?"}`,
  );
  if (p.platform_type === "CLOUD_API") {
    console.log(`${indent}  ✓ on the Cloud API — this is the id for Settings -> Messaging`);
  } else {
    console.log(`${indent}  ✗ not on the Cloud API. Next: pnpm wa:number request-code ${p.id}`);
  }
}

/**
 * What this token can actually see. Worth running first every time: an id that
 * has been torn down and an id your token cannot reach produce the identical
 * error from Meta, and only an enumeration tells them apart.
 */
async function list(argv: string[]): Promise<void> {
  const token = tokenFrom(argv);

  const me = await graphGet("me?fields=id,name", token);
  console.log(me.ok ? `Token belongs to: ${me.json.name ?? "(unnamed)"} (${me.json.id})` : "Token identity unreadable");

  const debug = await graphGet(`debug_token?input_token=${encodeURIComponent(token)}`, token);
  if (debug.ok) {
    const d = (debug.json as { data?: Record<string, unknown> }).data ?? {};
    const scopes = (d.granular_scopes ?? []) as Array<{ scope: string; target_ids?: string[] }>;
    const expiry =
      d.expires_at === 0 ? "never" : new Date(Number(d.expires_at) * 1000).toISOString().replace("T", " ").slice(0, 16);
    console.log(`Token type: ${d.type ?? "?"}   valid: ${d.is_valid}   expires: ${expiry}`);

    // Print what the token actually holds. Inferring a missing scope from a
    // (#200) is exactly the guessing this tool exists to end.
    const held = new Set((d.scopes ?? []) as string[]);
    console.log(`Scopes: ${[...held].join(", ") || "(none)"}`);
    const needed = ["business_management", "whatsapp_business_management", "whatsapp_business_messaging"];
    const missing = needed.filter((n) => !held.has(n));
    if (missing.length > 0) {
      console.log(`  MISSING: ${missing.join(", ")}`);
      if (missing.includes("business_management")) {
        console.log("  Without business_management the WABA enumeration below cannot run at all —");
        console.log("  it is easy to miss, because the WhatsApp scopes are the ones you go looking for.");
      }
    }

    // Only a system user has assets assigned to it; a user token inherits the
    // person's own access, so the absence of target_ids means nothing there.
    const assets = scopes.flatMap((s) => s.target_ids ?? []);
    if (d.type === "SYSTEM_USER" && scopes.length > 0 && assets.length === 0) {
      console.log(
        "  NOTE: the scopes carry no target_ids, so this system user has permissions but no\n" +
          "  assets assigned. Add the WABA under Business Settings -> Users -> System Users ->\n" +
          "  Add Assets -> WhatsApp Accounts -> Full control, or every read below fails as\n" +
          "  though the account did not exist.",
      );
    }
  }

  const businessId = arg(argv, "--business") ?? process.env.WHATSAPP_BUSINESS_ID;
  const wabaIds = new Set<string>();
  const explicit = arg(argv, "--waba") ?? process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (explicit) wabaIds.add(explicit);

  if (businessId) {
    for (const edge of ["owned_whatsapp_business_accounts", "client_whatsapp_business_accounts"]) {
      const res = await graphGet(`${businessId}/${edge}?fields=id,name`, token);
      if (!res.ok) {
        console.log(`\n${edge}: ${describeGraphError(res.json, res.status)}`);
        continue;
      }
      for (const w of ((res.json as { data?: Array<{ id: string }> }).data ?? [])) wabaIds.add(w.id);
    }
  } else {
    console.log(
      "\nNo business id given, so WABAs cannot be discovered. Pass --business <id> or set\n" +
        "WHATSAPP_BUSINESS_ID to list every account; otherwise only --waba is inspected.",
    );
  }

  if (wabaIds.size === 0) {
    console.log("\nNo WhatsApp Business Account reachable with this token.");
    return;
  }

  for (const waba of wabaIds) {
    const acct = await graphGet(`${waba}?fields=id,name,account_review_status`, token);
    if (!acct.ok) {
      console.log(`\nWABA ${waba}: ${describeGraphError(acct.json, acct.status)}`);
      continue;
    }
    console.log(`\nWABA ${waba} — ${acct.json.name} (review: ${acct.json.account_review_status ?? "?"})`);

    const phones = await graphGet(
      `${waba}/phone_numbers?fields=id,display_phone_number,verified_name,status,platform_type,code_verification_status`,
      token,
    );
    if (!phones.ok) {
      console.log(`  numbers: ${describeGraphError(phones.json, phones.status)}`);
      continue;
    }
    const data = ((phones.json as { data?: PhoneNumber[] }).data ?? []);
    if (data.length === 0) {
      console.log("  no phone numbers. Add one in WhatsApp Manager -> Account tools -> Phone numbers.");
    }
    for (const p of data) describeNumber(p);

    const subs = await graphGet(`${waba}/subscribed_apps`, token);
    if (subs.ok) {
      const apps = ((subs.json as { data?: Array<Record<string, unknown>> }).data ?? []);
      if (apps.length === 0) {
        console.log("  apps subscribed: NONE — webhooks will never arrive. Fix with:");
        console.log(`    pnpm wa:number subscribe ${waba}`);
      } else {
        console.log(`  apps subscribed: ${apps.length}`);
      }
    }
  }
}

async function status(argv: string[], numberId: string): Promise<void> {
  const token = tokenFrom(argv);
  const res = await graphGet(
    `${numberId}?fields=id,display_phone_number,verified_name,status,platform_type,code_verification_status`,
    token,
  );
  if (!res.ok) return fail(describeGraphError(res.json, res.status));
  describeNumber(res.json as PhoneNumber, "  ");
}

async function requestCode(argv: string[], numberId: string): Promise<void> {
  const token = tokenFrom(argv);
  const method = (arg(argv, "--method") ?? "SMS").toUpperCase();
  const res = await graphPost(`${numberId}/request_code`, token, { code_method: method, language: "en_US" });
  if (!res.ok) {
    const err = (res.json.error ?? {}) as Record<string, unknown>;
    let hint = "";
    if (err.error_subcode === 2388091) {
      hint =
        "\n\nSubcode 2388091 claims the servers are busy, but it persists for days when the real\n" +
        "cause is that the number is not free to move. The usual reasons, in order:\n" +
        "  1. The number is still signed in to WhatsApp or WhatsApp Business on a handset.\n" +
        "     Delete that account in the app first — this is the most common cause by far.\n" +
        "  2. It is registered to an On-Premise instance that must deregister it.\n" +
        "  3. The WhatsApp Business Account has no payment method attached.\n" +
        "Retrying will not change any of these.";
    }
    return fail(describeGraphError(res.json, res.status) + hint);
  }
  console.log(`Code sent by ${method}. Next:  pnpm wa:number verify ${numberId} <the 6 digits>`);
}

async function verify(argv: string[], numberId: string, code: string): Promise<void> {
  const token = tokenFrom(argv);
  if (!/^\d{6}$/.test(code)) {
    return fail(`"${code}" is not a 6-digit code. Pass the digits you received, with nothing around them.`);
  }
  const res = await graphPost(`${numberId}/verify_code`, token, { code });
  if (!res.ok) return fail(describeGraphError(res.json, res.status));
  console.log(`Verified. Next:  pnpm wa:number register ${numberId} <a 6-digit PIN you choose>`);
}

async function register(argv: string[], numberId: string, pin: string): Promise<void> {
  const token = tokenFrom(argv);
  if (!/^\d{6}$/.test(pin)) {
    return fail(`"${pin}" is not a 6-digit PIN. Choose six digits — it becomes the number's two-step PIN, so record it.`);
  }
  const res = await graphPost(`${numberId}/register`, token, { json: { messaging_product: "whatsapp", pin } });
  if (!res.ok) return fail(describeGraphError(res.json, res.status));
  console.log("Registered on the Cloud API. Keep that PIN — it is the number's two-step verification PIN.\n");
  await status(argv, numberId);
  console.log(
    "\nRemaining, none of which is code:\n" +
      "  1. Console -> Settings -> Messaging: this phone number id, the WABA id, the token.\n" +
      "  2. pnpm wa:number subscribe <wabaId>   (so webhooks arrive at all)\n" +
      "  3. Message the number and watch Messages in the console.",
  );
}

async function subscribe(argv: string[], wabaId: string): Promise<void> {
  const token = tokenFrom(argv);
  const res = await graphPost(`${wabaId}/subscribed_apps`, token, {});
  if (!res.ok) return fail(describeGraphError(res.json, res.status));
  console.log("App subscribed to this WABA. Inbound messages will now reach the webhook.");
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function usage(): void {
  console.log(
    "pnpm wa:number list                        every WABA and number this token can reach\n" +
      "pnpm wa:number status <numberId>           platform / status / verification\n" +
      "pnpm wa:number request-code <numberId>     send the SMS verification code\n" +
      "pnpm wa:number verify <numberId> <code>    confirm the 6 digits\n" +
      "pnpm wa:number register <numberId> <pin>   register on the Cloud API\n" +
      "pnpm wa:number subscribe <wabaId>          subscribe this app, so webhooks arrive\n\n" +
      "Adding a number to a WABA is not here: it needs Tech Provider access over the API,\n" +
      "so do it in WhatsApp Manager -> Account tools -> Phone numbers, then come back.",
  );
}

async function main(): Promise<void> {
  const [mode, a, b, ...rest] = process.argv.slice(2);
  const argv = [a, b, ...rest].filter((v): v is string => v !== undefined);
  switch (mode) {
    case "list":
      return list(process.argv.slice(2));
    case "status":
      return a ? status(argv, a) : fail("Usage: pnpm wa:number status <numberId>");
    case "request-code":
      return a ? requestCode(argv, a) : fail("Usage: pnpm wa:number request-code <numberId>");
    case "verify":
      return a && b ? verify(argv, a, b) : fail("Usage: pnpm wa:number verify <numberId> <code>");
    case "register":
      return a && b ? register(argv, a, b) : fail("Usage: pnpm wa:number register <numberId> <pin>");
    case "subscribe":
      return a ? subscribe(argv, a) : fail("Usage: pnpm wa:number subscribe <wabaId>");
    default:
      return usage();
  }
}

void main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
