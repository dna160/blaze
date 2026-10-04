/**
 * WhatsApp Cloud template registry — the single source of truth for what is
 * registered with Meta and what we send at runtime.
 *
 * WHY THIS EXISTS. A WhatsApp template is positional: Meta stores a body with
 * `{{1}}..{{n}}` and the send call supplies an ordered array. The first cut of
 * both senders built that array with `Object.values(variables)`, which made the
 * wire format depend on JavaScript object insertion order at each call site.
 * That is not a style problem — it is a correctness one:
 *
 *   - `notifyCustomer` appends `customerName` only when the call site omitted it
 *     AND the customer has a name, so `booking_approved_payment_link` sent three
 *     parameters for an anonymous customer and four for a named one. Meta
 *     rejects whichever count doesn't match the registered template, so one of
 *     the two always failed.
 *   - Call sites pass values the copy never shows (`bookingId`, `voidedInvoices`),
 *     which would have to appear in the registered body as visible text.
 *   - `booking_received` is sent from two call sites with different variable
 *     sets entirely (the storage flow and the pre-v2 nightly/duration flow).
 *
 * So: each template declares its parameters by NAME, in order. The senders read
 * them by name. Arity is a property of this file, not of the caller.
 *
 * Registering these with Meta is `pnpm wa:templates push` — see
 * `apps/api/scripts/whatsapp-templates.ts` and `docs/WHATSAPP-SETUP.md`.
 */

export type MetaTemplateCategory = "UTILITY" | "AUTHENTICATION" | "MARKETING";

export interface WhatsAppTemplateSpec {
  /**
   * Template name as registered in Meta. Several internal template keys may
   * share one — the dunning ladder mints `invoice_reminder_h7`,
   * `invoice_reminder_h3`… per tenant-configurable schedule, and Meta cannot
   * hold a template per possible day count, so the day becomes a parameter.
   */
  metaName: string;
  category: MetaTemplateCategory;
  /** Variable names in `{{1}}..{{n}}` order. The send array is built from these. */
  params: readonly string[];
  /**
   * Body text to register with Meta, `{{n}}` matching `params`. Bahasa first,
   * English second, same as the email copy in `templates.ts`.
   *
   * Never ends on a bare placeholder: Meta's reviewers routinely reject bodies
   * that begin or end with a variable, so every one closes on real text.
   */
  body: string;
  /**
   * Meta's AUTHENTICATION category: the body text is fixed by Meta (it cannot
   * be customised) and the code is echoed into a copy-code button, which
   * changes the send payload. `body` below is Meta's own wording, recorded for
   * the setup doc — it is not submitted.
   */
  authentication?: boolean;
}

const LANGUAGE = "id";

/** Bahasa/English closing line, so no body ends on a placeholder. */
const THANKS = "Terima kasih. / Thank you.";

/**
 * Dunning specs are named consts because `resolveWhatsAppTemplate` refers to
 * them directly — the ladder's day count is tenant-configurable, so these are
 * reached by pattern rather than by key.
 */
const INVOICE_REMINDER: WhatsAppTemplateSpec = {
  metaName: "invoice_reminder",
  category: "UTILITY",
  params: ["customerName", "invoiceNumber", "totalAmount", "daysUntilDue", "link"],
  body:
    "Halo {{1}}, invoice {{2}} sebesar Rp {{3}} akan jatuh tempo dalam {{4}} hari. Mohon dibayar tepat waktu.\n" +
    "Hi {{1}}, invoice {{2}} for Rp {{3}} is due in {{4}} day(s). Please pay on time.\n\n" +
    `Bayar / Pay: {{5}}\n${THANKS}`,
};

const INVOICE_OVERDUE: WhatsAppTemplateSpec = {
  metaName: "invoice_overdue",
  category: "UTILITY",
  params: ["customerName", "invoiceNumber", "daysOverdue", "link"],
  body:
    "Halo {{1}}, invoice {{2}} sudah lewat jatuh tempo {{3}} hari. Mohon segera dibayar untuk menghindari penangguhan akses.\n" +
    "Hi {{1}}, invoice {{2}} is {{3}} day(s) overdue. Please pay as soon as possible to avoid access being suspended.\n\n" +
    `Bayar / Pay: {{4}}\n${THANKS}`,
};

/**
 * Branch-admin leg (#42). Staff have a console session rather than a magic link,
 * so these carry no `{link}` — and they name the invoice for internal triage,
 * which is why they cannot reuse the customer templates above.
 */
const INVOICE_REMINDER_ADMIN: WhatsAppTemplateSpec = {
  metaName: "invoice_reminder_admin",
  category: "UTILITY",
  params: ["invoiceNumber", "totalAmount", "daysUntilDue"],
  body:
    "Pengingat internal: invoice {{1}} sebesar Rp {{2}} jatuh tempo dalam {{3}} hari.\n" +
    "Internal reminder: invoice {{1}} (Rp {{2}}) is due in {{3}} day(s). Check the console for details.",
};

const INVOICE_OVERDUE_ADMIN: WhatsAppTemplateSpec = {
  metaName: "invoice_overdue_admin",
  category: "UTILITY",
  params: ["invoiceNumber", "daysOverdue"],
  body:
    "Perhatian: invoice {{1}} sudah lewat jatuh tempo {{2}} hari.\n" +
    "Attention: invoice {{1}} is {{2}} day(s) overdue. Check the console for details.",
};

const TEMPLATES: Record<string, WhatsAppTemplateSpec> = {
  /* ---------------------------------------------------------------- booking */

  booking_received: {
    metaName: "booking_received",
    category: "UTILITY",
    params: ["customerName", "assetTypeName", "locationName", "termMonths", "startDate", "link"],
    body:
      "Halo {{1}}, permintaan unit {{2}} di {{3}} untuk {{4}} bulan mulai {{5}} sudah kami terima. Tim kami akan mengonfirmasi segera.\n" +
      "Hi {{1}}, we received your request for a {{2}} unit at {{3}} for {{4}} month(s) starting {{5}}. We'll confirm shortly.\n\n" +
      `Lihat status / Track it: {{6}}\n${THANKS}`,
  },

  /**
   * The pre-v2 NIGHTLY / DURATION_ORDER path (booking.service.ts:309) has no
   * term, branch or unit type to quote, so it cannot share the template above —
   * a different parameter count is a different Meta template, full stop.
   */
  booking_received_basic: {
    metaName: "booking_received_basic",
    category: "UTILITY",
    params: ["customerName", "startDate", "link"],
    body:
      "Halo {{1}}, permintaan booking Anda untuk {{2}} sudah kami terima. Tim kami akan mengonfirmasi segera.\n" +
      "Hi {{1}}, we received your booking request for {{2}} and will confirm shortly.\n\n" +
      `Lihat status / Track it: {{3}}\n${THANKS}`,
  },

  booking_waitlisted: {
    metaName: "booking_waitlisted",
    category: "UTILITY",
    params: ["customerName", "assetTypeName", "locationName", "position", "link"],
    body:
      "Halo {{1}}, unit {{2}} di {{3}} sedang penuh untuk tanggal yang Anda pilih. Anda berada di daftar tunggu nomor {{4}}. Kami akan menghubungi Anda begitu ada unit kosong.\n" +
      "Hi {{1}}, {{2}} at {{3}} is full for your dates — you're number {{4}} on the waitlist and we'll reach out as soon as a unit frees up.\n\n" +
      `Lihat status / Track it: {{5}}\n${THANKS}`,
  },

  booking_approved: {
    metaName: "booking_approved",
    category: "UTILITY",
    params: ["customerName", "link"],
    body:
      "Halo {{1}}, permintaan Anda disetujui. Langkah berikutnya: verifikasi identitas (unggah KTP dan selfie) melalui tautan di bawah.\n" +
      "Hi {{1}}, your request is approved. Next step: verify your identity (KTP + selfie) using the link below.\n\n" +
      `Mulai verifikasi / Start: {{2}}\n${THANKS}`,
  },

  booking_approved_payment_link: {
    metaName: "booking_approved_payment_link",
    category: "UTILITY",
    params: ["customerName", "invoiceNumber", "totalAmount", "link"],
    body:
      "Halo {{1}}, booking Anda disetujui. Invoice {{2}} sebesar Rp {{3}} menunggu pembayaran.\n" +
      "Hi {{1}}, your booking is approved. Invoice {{2}} for Rp {{3}} is awaiting payment.\n\n" +
      `Bayar sekarang / Pay now: {{4}}\n${THANKS}`,
  },

  booking_rejected: {
    metaName: "booking_rejected",
    category: "UTILITY",
    params: ["customerName", "reason"],
    body:
      "Halo {{1}}, mohon maaf, permintaan booking Anda tidak dapat kami proses. Alasan: {{2}}.\n" +
      "Hi {{1}}, we're sorry — we couldn't process your booking request. Reason: {{2}}.\n\n" +
      THANKS,
  },

  booking_expired: {
    metaName: "booking_expired",
    category: "UTILITY",
    params: ["customerName", "assetTypeName", "link"],
    body:
      "Halo {{1}}, permintaan Anda untuk {{2}} kedaluwarsa karena belum diproses dalam waktu yang ditentukan. Silakan ajukan kembali.\n" +
      "Hi {{1}}, your request for {{2}} expired before it could be processed — please submit a new one.\n\n" +
      `Ajukan lagi / Start again: {{3}}\n${THANKS}`,
  },

  waitlist_unit_offered: {
    metaName: "waitlist_unit_offered",
    category: "UTILITY",
    params: ["customerName", "assetTypeName", "assetCode", "locationName", "link"],
    body:
      "Kabar baik {{1}}! Unit {{2}} ({{3}}) di {{4}} sekarang tersedia untuk Anda. Tim kami sedang memproses persetujuannya.\n" +
      "Good news {{1}} — unit {{2}} ({{3}}) at {{4}} is now available for you and your request is being approved.\n\n" +
      `Lihat status / Track it: {{5}}\n${THANKS}`,
  },

  /* ------------------------------------------------------------ onboarding */

  /**
   * Passwordless sign-in. Exists because Meta gates AUTHENTICATION-category
   * templates separately, and `otp_code` is refused on a new WABA — but a link
   * that signs the customer straight into their own rental is better UX than a
   * code they have to retype, and it rides a category this account can create.
   */
  login_link: {
    metaName: "login_link",
    category: "UTILITY",
    params: ["customerName", "link"],
    body:
      "Halo {{1}}, berikut tautan untuk masuk ke akun sewa Anda. Tautan ini hanya berlaku 15 menit dan hanya untuk Anda — mohon jangan dibagikan.\n" +
      "Hi {{1}}, here is your link to sign in to your rental account. It is valid for 15 minutes and is just for you — please don't share it.\n\n" +
      `Masuk / Sign in: {{2}}\n${THANKS}`,
  },

  kyc_requested: {
    metaName: "kyc_requested",
    category: "UTILITY",
    params: ["customerName", "link"],
    body:
      "Halo {{1}}, mohon unggah foto KTP dan selfie Anda agar kami bisa menyiapkan kontrak. Tautan ini langsung masuk ke akun Anda tanpa kode OTP.\n" +
      "Hi {{1}}, please upload your KTP and a selfie so we can prepare your contract. This link signs you in directly — no OTP needed.\n\n" +
      `Unggah / Upload: {{2}}\n${THANKS}`,
  },

  contract_proforma_ready: {
    metaName: "contract_proforma_ready",
    category: "UTILITY",
    params: ["customerName", "invoiceNumber", "totalAmount", "dueDate", "assetCode", "link"],
    body:
      "Halo {{1}}, kontrak sewa dan proforma invoice {{2}} sebesar Rp {{3}} sudah siap. Mohon dibayar sebelum {{4}} untuk mengamankan unit {{5}}.\n" +
      "Hi {{1}}, your rental agreement and proforma invoice {{2}} (Rp {{3}}) are ready — please pay by {{4}} to secure unit {{5}}.\n\n" +
      `Bayar sekarang / Pay now: {{6}}\n${THANKS}`,
  },

  /* --------------------------------------------------------------- finance */

  invoice_issued: {
    metaName: "invoice_issued",
    category: "UTILITY",
    params: ["customerName", "invoiceNumber", "totalAmount", "dueDate", "link"],
    body:
      "Halo {{1}}, invoice {{2}} sebesar Rp {{3}} telah diterbitkan dan jatuh tempo {{4}}.\n" +
      "Hi {{1}}, invoice {{2}} for Rp {{3}} has been issued and is due {{4}}.\n\n" +
      `Bayar / Pay: {{5}}\n${THANKS}`,
  },

  invoice_paid: {
    metaName: "invoice_paid",
    category: "UTILITY",
    params: ["customerName", "invoiceNumber", "totalAmount", "link"],
    body:
      "Terima kasih {{1}}, pembayaran invoice {{2}} sebesar Rp {{3}} sudah kami terima.\n" +
      "Thanks {{1}} — payment for invoice {{2}} (Rp {{3}}) is confirmed.\n\n" +
      `Lihat kuitansi / View receipt: {{4}}\n${THANKS}`,
  },

  // Dunning. Declared above as consts, since the tenant-configurable ladder
  // reaches them by pattern (`invoice_reminder_h5`) rather than by key.
  invoice_reminder: INVOICE_REMINDER,
  invoice_overdue: INVOICE_OVERDUE,
  invoice_reminder_admin: INVOICE_REMINDER_ADMIN,
  invoice_overdue_admin: INVOICE_OVERDUE_ADMIN,

  lease_suspended: {
    metaName: "lease_suspended",
    category: "UTILITY",
    params: ["customerName", "invoiceNumber", "link"],
    body:
      "Halo {{1}}, invoice {{2}} belum dibayar, sehingga akses ke unit Anda ditangguhkan sampai pembayaran kami terima.\n" +
      "Hi {{1}}, invoice {{2}} is unpaid, so access to your unit is suspended until payment lands.\n\n" +
      `Bayar untuk membuka / Pay to restore: {{3}}\n${THANKS}`,
  },

  /* ----------------------------------------------------------- term / exit */

  /**
   * The one renewal gate on a term lease — H-14 before `endDate`, not per
   * month (BUILD-SPEC C4 reconciled with PRD v2 D1).
   */
  term_renewal_offer_h14: {
    metaName: "term_renewal_offer_h14",
    category: "UTILITY",
    params: ["customerName", "assetTypeName", "assetCode", "endDate", "link"],
    body:
      "Halo {{1}}, masa sewa unit {{2}} ({{3}}) berakhir pada {{4}}. Ingin memperpanjang? Pilih 1, 3, 6, atau 12 bulan melalui tautan di bawah. Tanpa konfirmasi, sewa berakhir pada tanggal tersebut.\n" +
      "Hi {{1}}, your rental of {{2}} ({{3}}) ends on {{4}}. To continue, pick a new 1/3/6/12-month term using the link below. Without a confirmation the rental simply ends on that date.\n\n" +
      `Perpanjang / Renew: {{5}}\n${THANKS}`,
  },

  /**
   * The RentalOrder (C4) renewal path. Previously had NO entry in the email
   * template map either, so it rendered as a `key: value` debug dump — the
   * customer received a raw UUID.
   */
  renewal_offer_h14: {
    metaName: "renewal_offer_h14",
    category: "UTILITY",
    params: ["customerName", "link"],
    body:
      "Halo {{1}}, masa sewa Anda akan berakhir dalam 14 hari. Ingin memperpanjang? Konfirmasi melalui tautan di bawah. Tanpa konfirmasi, sewa berakhir pada tanggal tersebut.\n" +
      "Hi {{1}}, your rental ends in 14 days. To continue, confirm using the link below. Without a confirmation the rental simply ends on that date.\n\n" +
      `Perpanjang / Renew: {{2}}\n${THANKS}`,
  },

  term_ended: {
    metaName: "term_ended",
    category: "UTILITY",
    params: ["customerName", "assetCode", "endDate", "link"],
    body:
      "Halo {{1}}, masa sewa unit {{2}} berakhir pada {{3}}. Tim kami akan memproses pengembalian deposit Anda setelah pemeriksaan unit.\n" +
      "Hi {{1}}, your rental of unit {{2}} ended on {{3}}. Our team will process your deposit refund after the unit inspection.\n\n" +
      `Lihat detail / View details: {{4}}\n${THANKS}`,
  },

  notice_confirmed: {
    metaName: "notice_confirmed",
    category: "UTILITY",
    params: ["customerName", "noticeEffectiveDate", "link"],
    body:
      "Halo {{1}}, pemberitahuan berhenti sewa Anda efektif {{2}} sudah kami catat.\n" +
      "Hi {{1}}, your termination notice effective {{2}} is recorded.\n\n" +
      `Lihat detail / View details: {{3}}\n${THANKS}`,
  },

  /* ------------------------------------------------------------------ auth */

  /**
   * Meta requires one-time passcodes to use the AUTHENTICATION category, whose
   * body copy is fixed by Meta and whose send payload echoes the code into a
   * copy-code button. Sending an OTP through a UTILITY template gets the
   * template rejected at review or the number flagged in production.
   */
  otp_code: {
    metaName: "otp_code",
    category: "AUTHENTICATION",
    authentication: true,
    params: ["code"],
    body: "{{1}} is your verification code. For your security, do not share this code.",
  },
};

/**
 * Meta rejects a parameter value containing a newline, a tab, or four or more
 * consecutive spaces. Customer-supplied names and rejection reasons are free
 * text, so every value is collapsed to single spaces before it goes on the
 * wire. Doing this at the boundary beats trusting a dozen call sites.
 */
export function sanitizeTemplateParam(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Internal template key -> spec. Resolves the dunning ladder's dynamic keys
 * (`invoice_reminder_h7`, `invoice_overdue_d3`, and the `_admin` leg of each)
 * onto their shared Meta template, returning the day count as a derived
 * parameter so the caller doesn't have to re-parse the key.
 */
export function resolveWhatsAppTemplate(
  templateKey: string,
): { spec: WhatsAppTemplateSpec; derived: Record<string, string> } | null {
  const direct = TEMPLATES[templateKey];
  if (direct) return { spec: direct, derived: {} };

  const reminder = /^invoice_reminder_h(\d+)(_admin)?$/.exec(templateKey);
  if (reminder?.[1]) {
    return {
      spec: reminder[2] ? INVOICE_REMINDER_ADMIN : INVOICE_REMINDER,
      derived: { daysUntilDue: reminder[1] },
    };
  }

  const overdue = /^invoice_overdue_d(\d+)(_admin)?$/.exec(templateKey);
  if (overdue?.[1]) {
    return {
      spec: overdue[2] ? INVOICE_OVERDUE_ADMIN : INVOICE_OVERDUE,
      derived: { daysOverdue: overdue[1] },
    };
  }

  return null;
}

/** Every distinct Meta template that must exist, for the registration script and the setup doc. */
export function allWhatsAppTemplates(): WhatsAppTemplateSpec[] {
  const seen = new Map<string, WhatsAppTemplateSpec>();
  for (const spec of Object.values(TEMPLATES)) if (!seen.has(spec.metaName)) seen.set(spec.metaName, spec);
  return [...seen.values()];
}

export class WhatsAppTemplateError extends Error {}

export interface WhatsAppSendPayload {
  messaging_product: "whatsapp";
  to: string;
  type: "template";
  template: Record<string, unknown>;
}

/**
 * The exact Graph API request body for one message. Shared by apps/api's
 * WhatsAppCloudMessagingProvider and apps/worker's own sender so the two can
 * never drift into sending different shapes for the same template.
 *
 * Throws rather than guessing: an unregistered key or a missing parameter is a
 * bug we want recorded on the notification row (status FAILED, with this
 * message) instead of a message that reaches the customer with a hole in it —
 * or, worse, one Meta accepts with the values shifted one position over.
 */
export function buildWhatsAppTemplatePayload(
  templateKey: string,
  to: string,
  variables: Record<string, string>,
): WhatsAppSendPayload {
  const resolved = resolveWhatsAppTemplate(templateKey);
  if (!resolved) {
    throw new WhatsAppTemplateError(
      `No WhatsApp template is registered for "${templateKey}". Add it to packages/domain/src/comms/whatsapp-templates.ts and run \`pnpm wa:templates push\`.`,
    );
  }

  const { spec, derived } = resolved;
  const source = { ...variables, ...derived };

  const values = spec.params.map((name) => {
    const raw = source[name];
    if (raw === undefined || raw === null || sanitizeTemplateParam(String(raw)) === "") {
      throw new WhatsAppTemplateError(
        `Template "${spec.metaName}" needs a non-empty "${name}" (parameter {{${spec.params.indexOf(name) + 1}}}) but got ${JSON.stringify(raw)}.`,
      );
    }
    return sanitizeTemplateParam(String(raw));
  });

  // Authentication templates carry the code twice: once in Meta's fixed body,
  // once in the copy-code button. Omitting the button component is a 132000.
  if (spec.authentication) {
    return {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: spec.metaName,
        language: { code: LANGUAGE },
        components: [
          { type: "body", parameters: [{ type: "text", text: values[0] }] },
          { type: "button", sub_type: "copy_code", index: "0", parameters: [{ type: "coupon_code", coupon_code: values[0] }] },
        ],
      },
    };
  }

  return {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: spec.metaName,
      language: { code: LANGUAGE },
      components: [{ type: "body", parameters: values.map((text) => ({ type: "text", text })) }],
    },
  };
}

export const WHATSAPP_TEMPLATE_LANGUAGE = LANGUAGE;
