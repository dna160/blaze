/**
 * Meta's refusal, parsed.
 *
 * The provider used to throw `new Error("WhatsApp Cloud API error 400: {json}")`
 * with the body truncated into the message. That is fine to log and useless to
 * act on: deciding whether a failure affects one recipient or the whole channel
 * meant pattern-matching a string that was already cut to 300 characters. This
 * keeps the code and subcode as numbers so callers can branch on them.
 */
export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
    readonly subcode: number | null,
    readonly detail: string | null,
    /**
     * Set when the sender already knows the answer — the linked-device bridge
     * reports it per refusal (not paired, disconnected, banned), so there is
     * no Meta code to classify.
     */
    private readonly channelWideOverride?: boolean,
  ) {
    super(message);
    this.name = "WhatsAppSendError";
  }

  /**
   * Meta nests the useful part under `error`, and not every refusal is JSON —
   * a gateway can answer with HTML, which is how an earlier version of the
   * template tooling produced "Unexpected token 'H'". A body we cannot parse
   * still yields an error carrying the HTTP status.
   */
  static fromResponse(status: number, body: string): WhatsAppSendError {
    let code: number | null = null;
    let subcode: number | null = null;
    let detail: string | null = null;
    let summary = body.slice(0, 300);

    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string }; error_user_msg?: string };
      };
      const err = parsed.error;
      if (err) {
        code = typeof err.code === "number" ? err.code : null;
        subcode = typeof err.error_subcode === "number" ? err.error_subcode : null;
        detail = err.error_data?.details ?? err.error_user_msg ?? null;
        summary = err.message ?? summary;
      }
    } catch {
      // Not JSON. `summary` keeps the raw prefix, which is what a human needs.
    }

    const parts = [`WhatsApp Cloud API error ${status}`, summary];
    if (code !== null) parts.push(`(code ${code}${subcode !== null ? `/${subcode}` : ""})`);
    if (detail) parts.push(`— ${detail}`);
    return new WhatsAppSendError(parts.join(" "), status, code, subcode, detail);
  }

  /**
   * Whether this refusal applies to every recipient on the tenant rather than
   * just the one we tried.
   *
   * The list is an allow-list, and unrecognised codes deliberately answer
   * false. Getting this wrong in the permissive direction is the more expensive
   * mistake: a per-recipient oddity misread as channel-wide would stop every
   * customer on the tenant from signing in for the breaker's whole TTL, which
   * is worse than the silence this classification exists to end.
   */
  get isChannelWide(): boolean {
    if (this.channelWideOverride !== undefined) return this.channelWideOverride;
    // An auth failure is about our credentials, never about who we messaged.
    if (this.status === 401 || this.status === 403) return true;
    if (this.code === null) return false;

    return CHANNEL_WIDE_CODES.has(this.code);
  }
}

/**
 * Codes that mean "nothing will send for this tenant until something changes".
 * Grouped by what an operator would actually have to go and fix.
 */
const CHANNEL_WIDE_CODES = new Set<number>([
  // Credentials and permissions.
  190, // access token expired, revoked or malformed
  10, // application does not have permission for this action
  200, // permissions error
  // The template itself — our bug or Meta's review, either way it affects all.
  132000, // number of parameters does not match the template
  132001, // template does not exist in this language / was never created
  132005, // translated text too long
  132007, // template format character policy violated
  132012, // template parameter format mismatch
  132015, // template is paused for low quality
  132016, // template is disabled
  // The number or the account.
  131031, // account has been locked
  131042, // business eligibility: payment issue
  131045, // phone number needs re-registration / certificate wrong
  133010, // phone number not registered
  // Throttling and outages: transient, but still true for everyone.
  130429, // rate limit hit
  131016, // service unavailable
  133004, // server temporarily unavailable
]);
