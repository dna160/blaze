/**
 * Client for apps/wa-bridge — the WhatsApp linked-device service (Project
 * Smile's whatsmeow approach). Shared by apps/api and apps/worker so both send
 * through one wire format, the way buildWhatsAppTemplatePayload is shared for
 * the Cloud API.
 *
 * The bridge is one deployment-wide service; each organization is one
 * "instance" on it, keyed by the organization id, holding the one WhatsApp
 * number that organization paired from the console.
 */

export interface WaBridgeConnection {
  baseUrl: string;
  token: string;
  /** The organization id. One paired number per organization (#40). */
  instanceId: string;
}

export type WaBridgeState =
  | "unpaired"
  | "pairing"
  | "connecting"
  | "connected"
  | "disconnected"
  | "logged_out"
  | "replaced"
  | "banned";

export interface WaBridgeStatus {
  id: string;
  state: WaBridgeState;
  detail?: string;
  /** Digits, no +. Present once paired. */
  phone?: string;
  pushName?: string;
  pairCode?: string;
  pairExpiresAt?: string;
  sentToday: number;
  dailyCap: number;
}

/**
 * The bridge's refusal. `channelWide` comes from the bridge itself (not paired,
 * disconnected, logged out, banned, daily cap): those stop every recipient, as
 * opposed to "this one number is not on WhatsApp".
 */
export class WaBridgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly channelWide: boolean,
  ) {
    super(message);
    this.name = "WaBridgeError";
  }
}

/** The deployment's bridge, or null when WA_BRIDGE_URL / WA_BRIDGE_TOKEN are unset. */
export function waBridgeFromEnv(): { baseUrl: string; token: string } | null {
  const baseUrl = process.env.WA_BRIDGE_URL;
  const token = process.env.WA_BRIDGE_TOKEN;
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

async function call<T>(conn: WaBridgeConnection, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${conn.baseUrl}/instances/${encodeURIComponent(conn.instanceId)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${conn.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Sends are paced by the bridge (a few seconds each, queued per number),
      // so a batch job's call can legitimately wait; it must not wait forever.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new WaBridgeError(`WhatsApp bridge unreachable at ${conn.baseUrl}: ${(err as Error).message}`, 0, "unreachable", true);
  }
  const text = await response.text();
  if (!response.ok) {
    let parsed: { error?: string; code?: string; channelWide?: boolean } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      // Not JSON (a proxy's HTML page). The status is still meaningful.
    }
    throw new WaBridgeError(
      parsed.error ?? `WhatsApp bridge answered ${response.status}: ${text.slice(0, 200)}`,
      response.status,
      parsed.code ?? "http_" + response.status,
      parsed.channelWide ?? (response.status === 401 || response.status >= 500),
    );
  }
  return JSON.parse(text) as T;
}

export async function waBridgeSendText(conn: WaBridgeConnection, to: string, text: string): Promise<{ id: string }> {
  return call(conn, "POST", "/send", { to, text });
}

export async function waBridgeMarkRead(conn: WaBridgeConnection, ids: string[]): Promise<void> {
  await call(conn, "POST", "/read", { ids }, 15_000);
}

export async function waBridgeStatus(conn: WaBridgeConnection): Promise<WaBridgeStatus> {
  return call(conn, "GET", "", undefined, 10_000);
}

export async function waBridgePair(conn: WaBridgeConnection, phone: string): Promise<{ code: string; expiresAt: string }> {
  return call(conn, "POST", "/pair", { phone }, 45_000);
}

export async function waBridgeLogout(conn: WaBridgeConnection): Promise<WaBridgeStatus> {
  return call(conn, "POST", "/logout", {}, 20_000);
}
