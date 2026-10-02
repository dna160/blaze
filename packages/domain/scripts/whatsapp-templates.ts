/**
 * Register / inspect this codebase's WhatsApp templates in Meta.
 *
 *   pnpm wa:templates print     # markdown table, for pasting into Meta by hand
 *   pnpm wa:templates push      # create every missing template via the Graph API
 *   pnpm wa:templates status    # what Meta currently holds, and what's missing
 *
 * `push` and `status` need, either as env vars or as `--waba`/`--token`:
 *   WHATSAPP_BUSINESS_ACCOUNT_ID   the WABA id (Meta Business Settings -> WhatsApp Accounts)
 *   WHATSAPP_CLOUD_TOKEN           a token with `whatsapp_business_management`
 *
 * Templates are derived from packages/domain/src/comms/whatsapp-templates.ts, so
 * adding a customer message is: add it there, run `push`, wait for approval.
 * Nothing here is destructive — Meta rejects a duplicate name+language and this
 * script reports that as "exists" rather than editing what's already live.
 */
import {
  allWhatsAppTemplates,
  WHATSAPP_TEMPLATE_LANGUAGE,
  type WhatsAppTemplateSpec,
} from "../src/comms/whatsapp-templates.js";

const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * Meta requires a sample value per `{{n}}` at submission — a template with
 * variables and no `example.body_text` is rejected outright. Keyed by parameter
 * name so a new template inherits sensible samples for free; reviewers read
 * these, so they are realistic Indonesian storage values, not "foo".
 */
const EXAMPLES: Record<string, string> = {
  customerName: "Budi Santoso",
  assetTypeName: "Unit 3x3",
  assetCode: "KJ-A-12",
  locationName: "Kebon Jeruk",
  termMonths: "6",
  startDate: "1 Oktober 2026",
  endDate: "31 Maret 2027",
  dueDate: "8 Oktober 2026",
  noticeEffectiveDate: "30 November 2026",
  position: "3",
  invoiceNumber: "INV-2026-10-0042",
  totalAmount: "2.750.000",
  daysUntilDue: "7",
  daysOverdue: "3",
  reason: "Foto KTP tidak terbaca",
  link: "https://sewa.example.co.id/m/8f2c1a",
  code: "483920",
};

function exampleFor(param: string): string {
  return EXAMPLES[param] ?? `contoh ${param}`;
}

/** The exact creation payload for one template. */
function creationPayload(spec: WhatsAppTemplateSpec): Record<string, unknown> {
  if (spec.authentication) {
    // Meta owns the copy for AUTHENTICATION: the body takes no text, only the
    // security-recommendation flag, and the code is delivered by an OTP button.
    return {
      name: spec.metaName,
      language: WHATSAPP_TEMPLATE_LANGUAGE,
      category: spec.category,
      components: [
        { type: "BODY", add_security_recommendation: true },
        { type: "FOOTER", code_expiration_minutes: 5 },
        { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE" }] },
      ],
    };
  }

  const body: Record<string, unknown> = { type: "BODY", text: spec.body };
  if (spec.params.length > 0) {
    body.example = { body_text: [spec.params.map(exampleFor)] };
  }
  return {
    name: spec.metaName,
    language: WHATSAPP_TEMPLATE_LANGUAGE,
    category: spec.category,
    components: [body],
  };
}

function credentials(argv: string[]): { waba: string; token: string } {
  const arg = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const waba = arg("--waba") ?? process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const token = arg("--token") ?? process.env.WHATSAPP_CLOUD_TOKEN;
  if (!waba || !token) {
    console.error(
      "Missing credentials. Set WHATSAPP_BUSINESS_ACCOUNT_ID and WHATSAPP_CLOUD_TOKEN,\n" +
        "or pass --waba <id> --token <token>. See docs/WHATSAPP-SETUP.md.",
    );
    process.exit(1);
  }
  checkCredential("WHATSAPP_CLOUD_TOKEN", token);
  checkCredential("WHATSAPP_BUSINESS_ACCOUNT_ID", waba);
  return { waba, token };
}

/**
 * Reject a value that is obviously a placeholder from the setup doc rather than
 * a real credential.
 *
 * Without this, a pasted `EAAP…` or `<your token>` reaches fetch() and comes
 * back as "Cannot convert argument to a ByteString because the character at
 * index 21 has a value of 8230" — an error about header encoding that says
 * nothing about the actual mistake. Anything outside printable ASCII cannot go
 * in an HTTP header at all, so checking here costs nothing and turns a dead end
 * into an instruction.
 */
function checkCredential(name: string, value: string): void {
  const nonAscii = [...value].find((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126);
  if (nonAscii) {
    console.error(
      `${name} contains a character that cannot appear in an HTTP header: ${JSON.stringify(nonAscii)} ` +
        `(U+${nonAscii.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}).\n` +
        "This is almost always a placeholder pasted from the docs — an ellipsis or angle brackets.\n" +
        "Paste the whole real value instead, with nothing standing in for the middle of it.",
    );
    process.exit(1);
  }
  if (/[<>]/.test(value) || /\.\.\./.test(value) || /\b(your|paste|token here)\b/i.test(value)) {
    console.error(
      `${name} still looks like a placeholder (${JSON.stringify(value.slice(0, 32))}...).\n` +
        "Replace it with the real value — including the angle brackets, if you copied those.",
    );
    process.exit(1);
  }
}

interface RemoteTemplate {
  name: string;
  status: string;
  category: string;
  language: string;
}

/**
 * Read a Graph response as JSON without assuming it is JSON. A corporate proxy,
 * an egress filter or a Meta error page all return text, and `res.json()` on
 * those throws "Unexpected token 'H'" — which hides both the status code and
 * whatever the body actually said.
 */
async function graphJson(res: Response): Promise<Record<string, unknown>> {
  const body = await res.text();
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Expected JSON from the Graph API but got ${res.status} ${res.statusText} with a non-JSON body:\n` +
        `${body.slice(0, 300)}\n` +
        "A proxy or network filter between you and graph.facebook.com is the usual cause.",
    );
  }
}

async function fetchRemote(waba: string, token: string): Promise<RemoteTemplate[]> {
  const out: RemoteTemplate[] = [];
  let url = `${GRAPH}/${waba}/message_templates?fields=name,status,category,language&limit=100`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = (await graphJson(res)) as {
      data?: RemoteTemplate[];
      paging?: { next?: string };
      error?: { message?: string; code?: number };
    };
    if (!res.ok) {
      const message = json.error?.message ?? `HTTP ${res.status}`;
      throw new Error(
        `Graph API rejected the request: ${message}\n` +
          (res.status === 403 || json.error?.code === 190
            ? "A 403 or code 190 here usually means the token lacks the whatsapp_business_management\n" +
              "scope, has expired, or the WABA id belongs to a different business than the token."
            : ""),
      );
    }
    out.push(...(json.data ?? []));
    url = json.paging?.next ?? "";
  }
  return out;
}

function print(): void {
  const specs = allWhatsAppTemplates();
  console.log(`# WhatsApp templates (${specs.length}, language \`${WHATSAPP_TEMPLATE_LANGUAGE}\`)\n`);
  console.log("Generated by `pnpm wa:templates print` from packages/domain/src/comms/whatsapp-templates.ts.\n");
  for (const spec of specs) {
    console.log(`## \`${spec.metaName}\` — ${spec.category}`);
    if (spec.authentication) {
      console.log("\nMeta supplies the body for AUTHENTICATION templates. Configure it as:");
      console.log("- Body: security recommendation **on**");
      console.log("- Footer: code expires in **5 minutes**");
      console.log("- Button: **Copy code**\n");
      continue;
    }
    console.log("\nParameters:\n");
    spec.params.forEach((p, i) => console.log(`- \`{{${i + 1}}}\` — \`${p}\` (e.g. ${exampleFor(p)})`));
    console.log("\nBody:\n\n```");
    console.log(spec.body);
    console.log("```\n");
  }
}

async function status(argv: string[]): Promise<void> {
  const { waba, token } = credentials(argv);
  const remote = await fetchRemote(waba, token);
  const byName = new Map(remote.filter((t) => t.language === WHATSAPP_TEMPLATE_LANGUAGE).map((t) => [t.name, t]));

  let missing = 0;
  let notApproved = 0;
  for (const spec of allWhatsAppTemplates()) {
    const found = byName.get(spec.metaName);
    if (!found) {
      missing += 1;
      console.log(`MISSING   ${spec.metaName}`);
      continue;
    }
    if (found.status !== "APPROVED") notApproved += 1;
    console.log(`${found.status.padEnd(9)} ${spec.metaName}${found.category !== spec.category ? `  (Meta says ${found.category}, we expect ${spec.category})` : ""}`);
  }
  console.log(`\n${allWhatsAppTemplates().length} expected · ${missing} missing · ${notApproved} not yet approved`);
  // A missing or unapproved template means those messages fail at send time, so
  // this is a useful CI/pre-launch gate, not just information.
  if (missing || notApproved) process.exitCode = 1;
}

async function push(argv: string[]): Promise<void> {
  const { waba, token } = credentials(argv);
  const existing = new Set(
    (await fetchRemote(waba, token)).filter((t) => t.language === WHATSAPP_TEMPLATE_LANGUAGE).map((t) => t.name),
  );

  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const spec of allWhatsAppTemplates()) {
    if (existing.has(spec.metaName)) {
      console.log(`exists    ${spec.metaName}`);
      skipped += 1;
      continue;
    }
    const res = await fetch(`${GRAPH}/${waba}/message_templates`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(creationPayload(spec)),
    });
    const json = (await graphJson(res)) as { id?: string; status?: string; error?: { message?: string } };
    if (!res.ok) {
      console.error(`FAILED    ${spec.metaName}: ${json.error?.message ?? res.status}`);
      failed += 1;
      continue;
    }
    console.log(`created   ${spec.metaName} (${json.status ?? "PENDING"})`);
    created += 1;
  }
  console.log(`\n${created} created · ${skipped} already there · ${failed} failed`);
  console.log("Approval is Meta's call and usually takes minutes; re-run `pnpm wa:templates status` to watch.");
  if (failed) process.exitCode = 1;
}

// Wrapped rather than top-level await: @rentos/domain is CommonJS, so tsx
// transforms this file to CJS where top-level await is a syntax error.
async function main(): Promise<void> {
  const [mode = "print", ...rest] = process.argv.slice(2);
  if (mode === "push") return push(rest);
  if (mode === "status") return status(rest);
  return print();
}

void main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
