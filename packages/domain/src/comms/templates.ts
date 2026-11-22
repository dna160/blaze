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
  /** Console → Settings → Messaging "send a test". Takes no variables, so only the connection can make it fail. */
  connection_test: () => ({
    subject: "Pesan percobaan / Test message",
    text:
      "Ini pesan percobaan dari console cabang Anda. Jika Anda menerimanya, koneksi WhatsApp cabang Anda sudah aktif.\n" +
      "This is a test message from your branch console. If you received it, your branch's WhatsApp connection is working.",
  }),
  booking_received: (vars) => ({
    subject: "Permintaan booking diterima / Booking request received",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, permintaan unit ${v(vars, "assetTypeName", "")} di ${v(vars, "locationName", "")} untuk ${v(vars, "termMonths", "")} bulan mulai ${v(vars, "startDate", "")} sudah kami terima. Tim kami akan mengonfirmasi segera.\n` +
      `Hi ${v(vars, "customerName", "there")}, we received your request. We'll confirm shortly.\n\nLihat status / Track it: ${v(vars, "link")}`,
  }),
  booking_received_basic: (vars) => ({
    subject: "Permintaan booking diterima / Booking request received",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, permintaan booking Anda untuk ${v(vars, "startDate", "")} sudah kami terima. Tim kami akan mengonfirmasi segera.\n` +
      `Hi ${v(vars, "customerName", "there")}, we received your booking request for ${v(vars, "startDate", "")} and will confirm shortly.\n\nLihat status / Track it: ${v(vars, "link")}`,
  }),
  booking_waitlisted: (vars) => ({
    subject: "Anda masuk daftar tunggu / You're on the waitlist",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, unit ${v(vars, "assetTypeName", "")} di ${v(vars, "locationName", "")} sedang penuh untuk tanggal yang Anda pilih. Anda berada di daftar tunggu nomor ${v(vars, "position", "?")}. Kami akan menghubungi Anda begitu ada unit kosong.\n` +
      `Hi, that size is full for your dates — you're #${v(vars, "position", "?")} on the waitlist and we'll reach out as soon as a unit frees up.\n\nLihat status / Track it: ${v(vars, "link")}`,
  }),
  /**
   * The one renewal gate on a term lease — H-14 before `endDate`, not per
   * month. Inside a signed term the customer already committed; this is the
   * boundary where the agreement would otherwise roll over silently, which is
   * exactly what BUILD-SPEC C4 set out to stop.
   */
  term_renewal_offer_h14: (vars) => ({
    subject: "Masa sewa berakhir 14 hari lagi / Your rental ends in 14 days",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, masa sewa unit ${v(vars, "assetTypeName", "")} ${v(vars, "assetCode", "")} berakhir pada ${v(vars, "endDate", "")}. Ingin memperpanjang? Pilih 1, 3, 6, atau 12 bulan melalui tautan di bawah. Tanpa konfirmasi, sewa berakhir pada tanggal tersebut.\n` +
      `Your rental ends on ${v(vars, "endDate", "")}. To continue, pick a new 1/3/6/12-month term using the link below. Without a confirmation the rental simply ends on that date.\n\nPerpanjang / Renew: ${v(vars, "link")}`,
  }),
  /**
   * The RentalOrder (C4) renewal path. Distinct from term_renewal_offer_h14
   * above, which is the PRD v2 term-lease gate and can quote the unit; this one
   * only knows that a term is ending. Without an entry here it rendered as a
   * `key: value` dump.
   */
  renewal_offer_h14: (vars) => ({
    subject: "Masa sewa berakhir 14 hari lagi / Your rental ends in 14 days",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, masa sewa Anda akan berakhir dalam 14 hari. Ingin memperpanjang? Konfirmasi melalui tautan di bawah. Tanpa konfirmasi, sewa berakhir pada tanggal tersebut.\n` +
      `Your rental ends in 14 days. To continue, confirm using the link below. Without a confirmation the rental simply ends on that date.\n\nPerpanjang / Renew: ${v(vars, "link")}`,
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
  login_link: (vars) => ({
    subject: "Tautan masuk / Your sign-in link",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, berikut tautan untuk masuk ke akun sewa Anda. Berlaku 15 menit, mohon jangan dibagikan.\n` +
      `Here is your link to sign in to your rental account. Valid for 15 minutes — please don't share it.\n\nMasuk / Sign in: ${v(vars, "link")}`,
  }),
  /** PRD go-live 2 §10.3 (T&C IV.3) — to the branch admin: held deposits past their refund date. */
  deposit_refund_task: (vars) => ({
    subject: "Deposit lewat batas pengembalian / Deposit refunds overdue",
    text:
      `Perhatian: ${v(vars, "count", "")} deposit sudah melewati batas pengembalian 30 hari dan masih ditahan: ${v(vars, "list", "")}. Proses refund di console.\n` +
      `Attention: ${v(vars, "count", "")} deposit(s) are past their 30-day refund date and still held: ${v(vars, "list", "")}. Process the refund in the console.`,
  }),
  /** PRD go-live §4.4 — staff, by email: no shared or default passwords. */
  staff_set_password: (vars) => ({
    // PRD go-live 2 §9.2 — the organization's console name, not the product's.
    subject: `Akun ${v(vars, "consoleName", "City Storage")} Anda / Your ${v(vars, "consoleName", "City Storage")} console account`,
    text:
      `Halo ${v(vars, "displayName", "")}, akun console ${v(vars, "consoleName", "City Storage")} untuk ${v(vars, "branchName", "City Storage")} sudah dibuat. Buat kata sandi Anda melalui tautan di bawah (sekali pakai, berlaku 72 jam).\n` +
      `Your ${v(vars, "consoleName", "City Storage")} console account for ${v(vars, "branchName", "City Storage")} is ready. Set your password with the link below (single use, valid 72 hours).\n\n${v(vars, "link")}`,
  }),
  // PRD go-live 2 §5.1 — `documents` / `documentsEn` list exactly what is still
  // missing (after a walk-in's KTP was taken at the counter, only the selfie).
  kyc_requested: (vars) => ({
    subject: "Verifikasi identitas Anda / Verify your identity",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, mohon unggah ${v(vars, "documents", "KTP (atau paspor) dan Selfie")} agar kami bisa menyiapkan kontrak. Tautan ini langsung masuk ke akun Anda tanpa kode OTP.\n` +
      `Please upload: ${v(vars, "documentsEn", "KTP (or passport) and Selfie")} — so we can prepare your contract. This link signs you in directly — no OTP needed.\n\n${v(vars, "link")}`,
  }),
  // PRD go-live 2 §5.2 — a rejected KYC batch always carries the reviewer's reason.
  kyc_rejected: (vars) => ({
    subject: "Dokumen perlu diunggah ulang / Please re-upload your documents",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, mohon maaf, dokumen verifikasi Anda belum dapat kami terima. Alasan: ${v(vars, "reason", "-")}. Silakan unggah ulang lewat tautan ini.\n` +
      `We're sorry — we could not accept your verification documents. Reason: ${v(vars, "reason", "-")}. Please upload them again using this link.\n\n${v(vars, "link")}`,
  }),
  // PRD go-live 2 §5.3 — signing on paper at the office, with a deadline.
  contract_sign_offline: (vars) => ({
    subject: "Tanda tangan kontrak di kantor / Sign your contract at our office",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, kontrak sewa unit ${v(vars, "assetCode", "")} sudah siap. Mohon datang ke ${v(vars, "locationName", "kantor kami")} untuk menandatanganinya paling lambat ${v(vars, "deadline", "")}.\n` +
      `Your rental agreement for unit ${v(vars, "assetCode", "")} is ready. Please come to ${v(vars, "locationName", "our office")} to sign it by ${v(vars, "deadline", "")}.\n\n${v(vars, "link")}`,
  }),
  contract_sign_reminder: (vars) => ({
    subject: `Pengingat tanda tangan kontrak / Contract signing reminder — ${v(vars, "deadline", "")}`,
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, kontrak sewa unit ${v(vars, "assetCode", "")} belum ditandatangani. Batas waktunya ${v(vars, "deadline", "")} (${v(vars, "daysLeft", "")} hari lagi) — mohon datang ke ${v(vars, "locationName", "kantor kami")}. Setelah batas waktu, pemesanan dibatalkan dan unit dilepas.\n` +
      `Your rental agreement for unit ${v(vars, "assetCode", "")} is not signed yet. The deadline is ${v(vars, "deadline", "")} (${v(vars, "daysLeft", "")} day(s) left) — please come to ${v(vars, "locationName", "our office")}. After the deadline the booking is cancelled and the unit released.\n\n${v(vars, "link")}`,
  }),
  contract_sign_lapsed: (vars) => ({
    subject: "Pemesanan dibatalkan / Booking cancelled — contract not signed",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, kontrak sewa unit ${v(vars, "assetCode", "")} tidak ditandatangani sampai batas waktu ${v(vars, "deadline", "")}, sehingga pemesanan dibatalkan dan unit dilepas. Silakan hubungi kami bila masih berminat.\n` +
      `Your rental agreement for unit ${v(vars, "assetCode", "")} was not signed by ${v(vars, "deadline", "")}, so the booking was cancelled and the unit released. Contact us if you are still interested.`,
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
  // PRD go-live 2 §6.1 — an admin sent a reset link (email only; staff, not customers).
  staff_password_reset: (vars) => ({
    subject: `Atur ulang kata sandi console ${v(vars, "consoleName", "City Storage")} / Reset your ${v(vars, "consoleName", "City Storage")} console password`,
    text:
      `Halo ${v(vars, "displayName", "")}, admin ${v(vars, "branchName", "City Storage")} mengirim tautan untuk mengatur ulang kata sandi console Anda. Kata sandi lama sudah tidak berlaku. Buat yang baru melalui tautan di bawah (sekali pakai, berlaku 72 jam).\n` +
      `An administrator at ${v(vars, "branchName", "City Storage")} sent you a link to reset your console password. Your old password no longer works. Set a new one with the link below (single use, valid 72 hours).\n\n${v(vars, "link")}`,
  }),
  booking_rejected: (vars) => ({
    subject: "Permintaan booking tidak dapat diproses / Booking request declined",
    text: `Mohon maaf, permintaan Anda tidak dapat kami proses. Alasan: ${v(vars, "reason", "-")}.\nSorry, we couldn't process your request. Reason: ${v(vars, "reason", "-")}.`,
  }),
  /** PRD go-live 2 §4.2 — an approved booking cancelled before it started (a change request was approved). */
  booking_cancelled: (vars) => ({
    subject: "Booking dibatalkan / Booking cancelled",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, booking Anda telah dibatalkan dan tagihan yang belum dibayar tidak berlaku lagi. Alasan: ${v(vars, "reason", "-")}.
` +
      `Hi ${v(vars, "customerName", "there")}, your booking has been cancelled and its unpaid invoice no longer applies. Reason: ${v(vars, "reason", "-")}.`,
  }),
  /** PRD go-live 2 §4.3 — the start (check-in) date of a booking was moved. */
  booking_date_changed: (vars) => ({
    subject: "Tanggal mulai sewa diubah / Rental start date changed",
    text:
      `Halo ${v(vars, "customerName", "Pelanggan")}, tanggal mulai sewa unit ${v(vars, "assetCode", "")} Anda diubah dari ${v(vars, "previousStartDate", "")} menjadi ${v(vars, "newStartDate", "")}. ${v(vars, "nextStep", "")}
` +
      `Hi ${v(vars, "customerName", "there")}, the start date of your rental of unit ${v(vars, "assetCode", "")} has moved from ${v(vars, "previousStartDate", "")} to ${v(vars, "newStartDate", "")}. ${v(vars, "nextStepEn", "")}

` +
      `Lihat booking / View your booking: ${v(vars, "link")}`,
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
};

/**
 * Every key `renderMessage` has copy for: the fixed templates above, plus one
 * representative of each dynamically keyed dunning family (the day count in
 * the key varies, the wording does not). The copy deck (`pnpm wa:templates
 * copy`) and the wording test iterate this, so a template added to TEMPLATES
 * shows up in both without touching either.
 */
export const DYNAMIC_MESSAGE_TEMPLATE_KEYS: ReadonlyArray<{ key: string; family: string }> = [
  { key: "invoice_reminder_h7", family: "invoice_reminder_h{n} — n hari sebelum jatuh tempo / n days before the due date" },
  { key: "invoice_overdue_d3", family: "invoice_overdue_d{n} — n hari setelah jatuh tempo / n days after the due date" },
  { key: "invoice_reminder_h7_admin", family: "invoice_reminder_h{n}_admin — salinan untuk admin cabang / the branch admin's copy" },
  { key: "invoice_overdue_d3_admin", family: "invoice_overdue_d{n}_admin — salinan untuk admin cabang / the branch admin's copy" },
];

export function messageTemplateKeys(): string[] {
  return [...Object.keys(TEMPLATES), ...DYNAMIC_MESSAGE_TEMPLATE_KEYS.map((d) => d.key)];
}

export function renderMessage(templateKey: string, variables: Vars): RenderedMessage {
  const template = TEMPLATES[templateKey];
  if (template) return template(variables);
  // Dunning reminders are keyed dynamically (invoice_reminder_h7, invoice_overdue_d3...).
  // #42's branch-admin leg. Checked BEFORE the customer prefixes below, which
  // would otherwise match `invoice_reminder_h7_admin` and tell staff to pay.
  if (templateKey.endsWith("_admin")) {
    const days = v(variables, "daysOverdue") || v(variables, "daysUntilDue");
    const overdue = templateKey.startsWith("invoice_overdue_");
    return {
      subject: `${overdue ? "Invoice terlambat / Overdue" : "Pengingat internal / Internal reminder"} — ${v(variables, "invoiceNumber", "")}`,
      text: overdue
        ? `Perhatian: invoice ${v(variables, "invoiceNumber", "")} sudah lewat jatuh tempo ${days} hari.\nAttention: invoice ${v(variables, "invoiceNumber", "")} is ${days} day(s) overdue. Check the console for details.`
        : `Pengingat internal: invoice ${v(variables, "invoiceNumber", "")} sebesar Rp ${v(variables, "totalAmount", "")} jatuh tempo dalam ${days} hari.\nInternal reminder: invoice ${v(variables, "invoiceNumber", "")} (Rp ${v(variables, "totalAmount", "")}) is due in ${days} day(s). Check the console for details.`,
    };
  }
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
