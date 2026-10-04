/**
 * Shared Graph API plumbing for the operator scripts.
 *
 * Extracted because both the template and the number tooling need the same
 * three things, and each of them exists because of a specific dead end this
 * setup actually hit: a placeholder pasted from the docs reaching fetch() as a
 * header, a proxy returning HTML where JSON was assumed, and Meta's generic
 * "Invalid parameter" hiding the sentence that said what was wrong.
 */

export const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * Reject a value that is obviously a placeholder rather than a credential.
 *
 * Without this, a pasted `EAAP…` or `<your token>` reaches fetch() and returns
 * "Cannot convert argument to a ByteString because the character at index 21 has
 * a value of 8230" — an error about header encoding that names neither the
 * variable nor the character nor the fix.
 */
export function checkCredential(name: string, value: string): void {
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
  if (/[<>]/.test(value) || /\.\.\./.test(value) || /\b(your|paste|token here|here)\b/i.test(value)) {
    console.error(
      `${name} still looks like a placeholder (${JSON.stringify(value.slice(0, 32))}...).\n` +
        "Replace it with the real value — including the angle brackets, if you copied those.",
    );
    process.exit(1);
  }
}

/**
 * Read a Graph response as JSON without assuming it is JSON. A corporate proxy,
 * an egress filter or a Meta error page all return text, and `res.json()` on
 * those throws "Unexpected token 'H'" — hiding both the status and the body.
 */
export async function graphJson(res: Response): Promise<Record<string, unknown>> {
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

/**
 * Meta's `message` is a top-level placeholder — "Invalid parameter",
 * "Unsupported get request" — and the reason sits in the sibling fields.
 * Printing only `message` turns a specific complaint into a dead end.
 *
 * Subcode 33 is called out by name because it is deliberately ambiguous: it
 * means missing object OR missing permission OR unsupported operation, and
 * guessing which has cost this setup several hours.
 */
export function describeGraphError(payload: Record<string, unknown>, status: number): string {
  const e = (payload.error ?? {}) as Record<string, unknown>;
  const data = (e.error_data ?? {}) as Record<string, unknown>;
  const parts = [
    e.message ?? `HTTP ${status}`,
    e.error_user_title ? `title: ${e.error_user_title}` : null,
    e.error_user_msg ? `detail: ${e.error_user_msg}` : null,
    data.details ? `details: ${data.details}` : null,
    e.code !== undefined ? `code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""}` : null,
  ].filter(Boolean);
  let text = parts.join(" · ");
  if (e.error_subcode === 33) {
    text +=
      "\n  Subcode 33 means one of: the id does not exist, your token has no access to it, or the\n" +
      "  endpoint does not support this call. Run `pnpm wa:number list` to see what this token can\n" +
      "  actually reach — an id that is simply gone looks identical to one you cannot see.";
  }
  return text;
}

/** GET, with the token as a query parameter. */
export async function graphGet(path: string, token: string): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${GRAPH}/${path}${sep}access_token=${encodeURIComponent(token)}`);
  return { ok: res.ok, status: res.status, json: await graphJson(res) };
}

/** POST, with the token as a bearer header and a form or JSON body. */
export async function graphPost(
  path: string,
  token: string,
  body: Record<string, string> | { json: Record<string, unknown> },
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const isJson = "json" in body;
  const res = await fetch(`${GRAPH}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": isJson ? "application/json" : "application/x-www-form-urlencoded",
    },
    body: isJson ? JSON.stringify(body.json) : new URLSearchParams(body as Record<string, string>).toString(),
  });
  return { ok: res.ok, status: res.status, json: await graphJson(res) };
}

/** The token, validated. Numbers tooling does not always know a WABA yet, so that stays optional. */
export function tokenFrom(argv: string[]): string {
  const i = argv.indexOf("--token");
  const token = i >= 0 ? argv[i + 1] : process.env.WHATSAPP_CLOUD_TOKEN;
  if (!token) {
    console.error(
      "No token. Set WHATSAPP_CLOUD_TOKEN or pass --token <token>.\n" +
        "Use the permanent System User token, not a Graph API Explorer one — those expire in an hour or two.",
    );
    process.exit(1);
  }
  checkCredential("WHATSAPP_CLOUD_TOKEN", token);
  return token;
}
