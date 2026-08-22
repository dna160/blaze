/**
 * Customer-facing message copy, keyed by the same templateKey the WhatsApp
 * Cloud adapter sends as the approved template name. WhatsApp templates
 * are registered with the BSP and only receive the variables; email has
 * no such registry, so the subject/body for the EMAIL channel is rendered
 * here (PRD v2 D3). Bahasa Indonesia first (tenant default locale),
 * English line below — one template, both languages, per PRD §7.1.5.
 *
 * `{link}` is the magic link (PRD v2 §9) every message carries.
 */
export interface RenderedMessage {
  subject: string;
  text: string;
}

type Vars = Record<string, string>;

const v = (vars: Vars, key: string, fallback = "") => vars[key] ?? fallback;

const TEMPLATES: Record<string, (vars: Vars) => RenderedMessage> = {
  booking_received: (vars) => ({
    subject: "Permintaan booking diterima / Booking request received",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, permintaan unit ${v(vars, "assetTypeName", "")} di ${v(vars, "locationName", "")} untuk ${v(vars, "termMonths", "")} bulan mulai ${v(vars, "startDate", "")} sudah kami terima. Tim kami akan mengonfirmasi segera.\n` +
      `Hi ${v(vars, "customerName", "there")}, we received your request. We'll confirm shortly.\n\nLihat status / Track it: ${v(vars, "link")}`,
  }),
  booking_waitlisted: (vars) => ({
    subject: "Anda masuk daftar tunggu / You're on the waitlist",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, unit ${v(vars, "assetTypeName", "")} di ${v(vars, "locationName", "")} sedang penuh untuk tanggal yang Anda pilih. Anda berada di daftar tunggu nomor ${v(vars, "position", "?")}. Kami akan menghubungi Anda begitu ada unit kosong.\n` +
      `Hi, that size is full for your dates — you're #${v(vars, "position", "?")} on the waitlist and we'll reach out as soon as a unit frees up.\n\nLihat status / Track it: ${v(vars, "link")}`,
  }),
  waitlist_unit_offered: (vars) => ({
    subject: "Unit tersedia untuk Anda / A unit is available for you",
    text:
      `Kabar baik! Unit ${v(vars, "assetTypeName", "")} (${v(vars, "assetCode", "")}) di ${v(vars, "locationName", "")} sekarang tersedia untuk Anda. Tim kami sedang memproses persetujuannya.\n` +
      `Good news — a unit is now available for you and your request is being approved.\n\nLihat status / Track it: ${v(vars, "link")}`,
  }),
  booking_approved: (vars) => ({
    subject: "Booking disetujui — langkah berikutnya / Booking approved — next step",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, permintaan Anda disetujui. Langkah berikutnya: verifikasi identitas (unggah KTP dan selfie) melalui tautan di bawah.\n` +
      `Your request is approved. Next: verify your identity (KTP + selfie) using the link below.\n\n${v(vars, "link")}`,
  }),
  kyc_requested: (vars) => ({
    subject: "Verifikasi identitas Anda / Verify your identity",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, mohon unggah foto KTP dan selfie Anda agar kami bisa menyiapkan kontrak. Tautan ini langsung masuk ke akun Anda tanpa kode OTP.\n` +
      `Please upload your KTP and a selfie so we can prepare your contract. This link signs you in directly — no OTP needed.\n\n${v(vars, "link")}`,
  }),
  contract_proforma_ready: (vars) => ({
    subject: `Kontrak & proforma ${v(vars, "invoiceNumber", "")} / Contract & proforma ready`,
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, kontrak sewa dan proforma invoice ${v(vars, "invoiceNumber", "")} sebesar Rp ${v(vars, "totalAmount", "")} sudah siap. Mohon dibayar sebelum ${v(vars, "dueDate", "")} untuk mengamankan unit ${v(vars, "assetCode", "")}.\n` +
      `Your rental agreement and proforma invoice ${v(vars, "invoiceNumber", "")} (Rp ${v(vars, "totalAmount", "")}) are ready — please pay by ${v(vars, "dueDate", "")} to secure unit ${v(vars, "assetCode", "")}.\n\nBayar sekarang / Pay now: ${v(vars, "link")}`,
  }),
  booking_approved_payment_link: (vars) => ({
    subject: `Invoice ${v(vars, "invoiceNumber", "")} — pembayaran / payment`,
    text: `Booking Anda disetujui. Invoice ${v(vars, "invoiceNumber", "")} sebesar Rp ${v(vars, "totalAmount", "")} menunggu pembayaran.\nYour booking is approved; invoice ${v(vars, "invoiceNumber", "")} for Rp ${v(vars, "totalAmount", "")} is awaiting payment.\n\n${v(vars, "link")}`,
  }),
  invoice_issued: (vars) => ({
    subject: `Invoice ${v(vars, "invoiceNumber", "")} diterbitkan / issued`,
    text: `Invoice ${v(vars, "invoiceNumber", "")} sebesar Rp ${v(vars, "totalAmount", "")} telah diterbitkan, jatuh tempo ${v(vars, "dueDate", "")}.\nInvoice ${v(vars, "invoiceNumber", "")} for Rp ${v(vars, "totalAmount", "")} is due ${v(vars, "dueDate", "")}.\n\nBayar / Pay: ${v(vars, "link")}`,
  }),
  invoice_paid: (vars) => ({
    subject: `Pembayaran diterima / Payment received — ${v(vars, "invoiceNumber", "")}`,
    text: `Terima kasih, pembayaran invoice ${v(vars, "invoiceNumber", "")} sebesar Rp ${v(vars, "totalAmount", "")} sudah kami terima.\nThanks — payment for ${v(vars, "invoiceNumber", "")} (Rp ${v(vars, "totalAmount", "")}) is confirmed.\n\n${v(vars, "link")}`,
  }),
  booking_rejected: (vars) => ({
    subject: "Permintaan booking tidak dapat diproses / Booking request declined",
    text: `Mohon maaf, permintaan Anda tidak dapat kami proses. Alasan: ${v(vars, "reason", "-")}.\nSorry, we couldn't process your request. Reason: ${v(vars, "reason", "-")}.`,
  }),
  booking_expired: (vars) => ({
    subject: "Permintaan booking kedaluwarsa / Booking request expired",
    text: `Permintaan Anda untuk ${v(vars, "assetTypeName", "")} kedaluwarsa karena belum diproses dalam waktu yang ditentukan. Silakan ajukan kembali.\nYour request expired before it could be processed — please submit again.\n\n${v(vars, "link")}`,
  }),
  term_ended: (vars) => ({
    subject: "Masa sewa berakhir / Your rental term has ended",
    text: `Masa sewa unit ${v(vars, "assetCode", "")} berakhir pada ${v(vars, "endDate", "")}. Tim kami akan memproses pengembalian deposit Anda.\nYour rental of unit ${v(vars, "assetCode", "")} ended on ${v(vars, "endDate", "")}; our team will process your deposit refund.\n\n${v(vars, "link")}`,
  }),
  notice_confirmed: (vars) => ({
    subject: "Pemberitahuan berhenti sewa diterima / Termination notice received",
    text: `Pemberitahuan berhenti sewa Anda efektif ${v(vars, "noticeEffectiveDate", "")} sudah kami catat.\nYour termination notice effective ${v(vars, "noticeEffectiveDate", "")} is recorded.\n\n${v(vars, "link")}`,
  }),
  lease_suspended: (vars) => ({
    subject: `Akses ditangguhkan / Access suspended — ${v(vars, "invoiceNumber", "")}`,
    text: `Invoice ${v(vars, "invoiceNumber", "")} belum dibayar; akses ke unit ditangguhkan sampai pembayaran diterima.\nInvoice ${v(vars, "invoiceNumber", "")} is unpaid; unit access is suspended until payment lands.\n\n${v(vars, "link")}`,
  }),
  otp_code: (vars) => ({
    subject: "Kode masuk / Your sign-in code",
    text: `Kode Anda: ${v(vars, "code", "")}. Berlaku 5 menit.\nYour code: ${v(vars, "code", "")}. Valid for 5 minutes.`,
  }),
};

export function renderMessage(templateKey: string, variables: Vars): RenderedMessage {
  const template = TEMPLATES[templateKey];
  if (template) return template(variables);
  // Dunning reminders are keyed dynamically (invoice_reminder_h7, invoice_overdue_d3...).
  if (templateKey.startsWith("invoice_reminder_")) {
    return {
      subject: `Pengingat pembayaran / Payment reminder — ${v(variables, "invoiceNumber", "")}`,
      text: `Invoice ${v(variables, "invoiceNumber", "")} sebesar Rp ${v(variables, "totalAmount", "")} akan jatuh tempo. Mohon dibayar tepat waktu.\nInvoice ${v(variables, "invoiceNumber", "")} (Rp ${v(variables, "totalAmount", "")}) is coming due.\n\nBayar / Pay: ${v(variables, "link")}`,
    };
  }
  if (templateKey.startsWith("invoice_overdue_")) {
    return {
      subject: `Invoice terlambat / Overdue — ${v(variables, "invoiceNumber", "")}`,
      text: `Invoice ${v(variables, "invoiceNumber", "")} sudah lewat jatuh tempo ${v(variables, "daysOverdue", "")} hari. Mohon segera dibayar.\nInvoice ${v(variables, "invoiceNumber", "")} is ${v(variables, "daysOverdue", "")} days overdue — please pay as soon as possible.\n\nBayar / Pay: ${v(variables, "link")}`,
    };
  }
  return { subject: templateKey, text: Object.entries(variables).map(([k, val]) => `${k}: ${val}`).join("\n") };
}

/**
 * Magic-link URL (PRD v2 §9): `{storefrontBase}/m/{token}?next=/portal/...`.
 * The storefront's /m/[token] page exchanges the token for a session and
 * redirects to `next`. Pure string assembly, shared by apps/api and
 * apps/worker so both mint identical links.
 */
export function buildMagicLinkUrl(storefrontBaseUrl: string, token: string, next: string): string {
  const base = storefrontBaseUrl.replace(/\/+$/, "");
  return `${base}/m/${encodeURIComponent(token)}?next=${encodeURIComponent(next)}`;
}
