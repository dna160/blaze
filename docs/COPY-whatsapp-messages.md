# Teks pesan WhatsApp & email — untuk ditinjau / Message wording — for review

Dibuat otomatis dari kode dengan `pnpm wa:templates copy --format md`. Perubahan kalimat dikerjakan di `packages/domain/src/comms/templates.ts`, lalu file ini dibuat ulang.
Generated from the code. Wording changes are made in `packages/domain/src/comms/templates.ts`, and this file is then regenerated.

**Cara meninjau / How to review**

- Setiap pesan di bawah diisi dengan data contoh (nama, unit, nomor invoice, tautan). Data contoh akan diganti data asli saat dikirim.
  Each message below is filled with sample data, which is replaced by the real data when it is sent.
- Tulis kalimat pengganti pada baris **Perubahan / Change** di bawah pesan yang ingin diubah. Kosongkan bila sudah sesuai.
  Write the replacement wording on the **Perubahan / Change** line under any message you want changed. Leave it blank if the message is fine.
- Bagian yang berasal dari data (nama pelanggan, nomor, tanggal, jumlah, tautan) tercantum pada baris *Data*; bagian itu tidak bisa diubah kalimatnya, hanya posisinya.
  The parts that come from data are listed on the *Data* line; their position can change, their content cannot.
- Setiap pesan dikirim dalam dua bahasa sekaligus: Bahasa Indonesia, lalu English.
  Every message carries both languages: Indonesian first, then English.
- Nominal ditulis apa adanya dari sistem (mis. `2100000`); bila ingin format `2.100.000`, tuliskan di baris Perubahan.
  Amounts print as the system holds them; say so on the Change line if you want `2.100.000`.

Jumlah pesan / Messages: 28

---

1. **`connection_test`** — untuk staf / to staff

    Subjek email / Email subject: Pesan percobaan RentOS / RentOS test message

    > Ini pesan percobaan dari RentOS. Jika Anda menerimanya, koneksi WhatsApp cabang Anda sudah aktif.
    > This is a test message from RentOS. If you received it, your branch's WhatsApp connection is working.

    *Data:* —

    **Perubahan / Change:**


2. **`booking_received`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Permintaan booking diterima / Booking request received

    > Halo Budi Santoso, permintaan unit Medium Storage di City Storage Kebon Jeruk untuk 3 bulan mulai 2026-11-27 sudah kami terima. Tim kami akan mengonfirmasi segera.
    > Hi Budi Santoso, we received your request. We'll confirm shortly.
    >
    > Lihat status / Track it: https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `customerName`, `assetTypeName`, `locationName`, `termMonths`, `startDate`, `link`

    **Perubahan / Change:**


3. **`booking_received_basic`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Permintaan booking diterima / Booking request received

    > Halo Budi Santoso, permintaan booking Anda untuk 2026-11-27 sudah kami terima. Tim kami akan mengonfirmasi segera.
    > Hi Budi Santoso, we received your booking request for 2026-11-27 and will confirm shortly.
    >
    > Lihat status / Track it: https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `customerName`, `startDate`, `link`

    **Perubahan / Change:**


4. **`booking_waitlisted`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Anda masuk daftar tunggu / You're on the waitlist

    > Halo Budi Santoso, unit Medium Storage di City Storage Kebon Jeruk sedang penuh untuk tanggal yang Anda pilih. Anda berada di daftar tunggu nomor 2. Kami akan menghubungi Anda begitu ada unit kosong.
    > Hi, that size is full for your dates — you're #2 on the waitlist and we'll reach out as soon as a unit frees up.
    >
    > Lihat status / Track it: https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `customerName`, `assetTypeName`, `locationName`, `position`, `link`

    **Perubahan / Change:**


5. **`term_renewal_offer_h14`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Masa sewa berakhir 14 hari lagi / Your rental ends in 14 days

    > Halo Budi Santoso, masa sewa unit Medium Storage STORAGE-12 berakhir pada 2027-02-27. Ingin memperpanjang? Pilih 1, 3, 6, atau 12 bulan melalui tautan di bawah. Tanpa konfirmasi, sewa berakhir pada tanggal tersebut.
    > Your rental ends on 2027-02-27. To continue, pick a new 1/3/6/12-month term using the link below. Without a confirmation the rental simply ends on that date.
    >
    > Perpanjang / Renew: https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `customerName`, `assetTypeName`, `assetCode`, `endDate`, `link`

    **Perubahan / Change:**


6. **`renewal_offer_h14`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Masa sewa berakhir 14 hari lagi / Your rental ends in 14 days

    > Halo Budi Santoso, masa sewa Anda akan berakhir dalam 14 hari. Ingin memperpanjang? Konfirmasi melalui tautan di bawah. Tanpa konfirmasi, sewa berakhir pada tanggal tersebut.
    > Your rental ends in 14 days. To continue, confirm using the link below. Without a confirmation the rental simply ends on that date.
    >
    > Perpanjang / Renew: https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `customerName`, `link`

    **Perubahan / Change:**


7. **`waitlist_unit_offered`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Unit tersedia untuk Anda / A unit is available for you

    > Kabar baik! Unit Medium Storage (STORAGE-12) di City Storage Kebon Jeruk sekarang tersedia untuk Anda. Tim kami sedang memproses persetujuannya.
    > Good news — a unit is now available for you and your request is being approved.
    >
    > Lihat status / Track it: https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `assetTypeName`, `assetCode`, `locationName`, `link`

    **Perubahan / Change:**


8. **`booking_approved`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Booking disetujui — langkah berikutnya / Booking approved — next step

    > Halo Budi Santoso, permintaan Anda disetujui. Langkah berikutnya: verifikasi identitas (unggah KTP dan selfie) melalui tautan di bawah.
    > Your request is approved. Next: verify your identity (KTP + selfie) using the link below.
    >
    > https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `customerName`, `link`

    **Perubahan / Change:**


9. **`login_link`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Tautan masuk / Your sign-in link

    > Halo Budi Santoso, berikut tautan untuk masuk ke akun sewa Anda. Berlaku 15 menit, mohon jangan dibagikan.
    > Here is your link to sign in to your rental account. Valid for 15 minutes — please don't share it.
    >
    > Masuk / Sign in: https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `customerName`, `link`

    **Perubahan / Change:**


10. **`staff_set_password`** — untuk staf / to staff

    Subjek email / Email subject: Akun RentOS Anda / Your RentOS console account

    > Halo Risa, akun console RentOS untuk City Storage Kebon Jeruk sudah dibuat. Buat kata sandi Anda melalui tautan di bawah (sekali pakai, berlaku 72 jam).
    > Your RentOS console account for City Storage Kebon Jeruk is ready. Set your password with the link below (single use, valid 72 hours).
    >
    > https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `displayName`, `branchName`, `link`

    **Perubahan / Change:**


11. **`kyc_requested`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Verifikasi identitas Anda / Verify your identity

    > Halo Budi Santoso, mohon unggah foto KTP dan selfie Anda agar kami bisa menyiapkan kontrak. Tautan ini langsung masuk ke akun Anda tanpa kode OTP.
    > Please upload your KTP and a selfie so we can prepare your contract. This link signs you in directly — no OTP needed.
    >
    > https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `customerName`, `link`

    **Perubahan / Change:**


12. **`contract_proforma_ready`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Kontrak & proforma 36-21112026-240-431 / Contract & proforma ready

    > Halo Budi Santoso, kontrak sewa dan proforma invoice 36-21112026-240-431 sebesar Rp 2100000 sudah siap. Mohon dibayar sebelum 2026-12-04 untuk mengamankan unit STORAGE-12.
    > Your rental agreement and proforma invoice 36-21112026-240-431 (Rp 2100000) are ready — please pay by 2026-12-04 to secure unit STORAGE-12.
    >
    > Bayar sekarang / Pay now: https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `invoiceNumber`, `customerName`, `totalAmount`, `dueDate`, `assetCode`, `link`

    **Perubahan / Change:**


13. **`booking_approved_payment_link`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Invoice 36-21112026-240-431 — pembayaran / payment

    > Booking Anda disetujui. Invoice 36-21112026-240-431 sebesar Rp 2100000 menunggu pembayaran.
    > Your booking is approved; invoice 36-21112026-240-431 for Rp 2100000 is awaiting payment.
    >
    > https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `invoiceNumber`, `totalAmount`, `link`

    **Perubahan / Change:**


14. **`invoice_issued`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Invoice 36-21112026-240-431 diterbitkan / issued

    > Invoice 36-21112026-240-431 sebesar Rp 2100000 telah diterbitkan, jatuh tempo 2026-12-04.
    > Invoice 36-21112026-240-431 for Rp 2100000 is due 2026-12-04.
    >
    > Bayar / Pay: https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `invoiceNumber`, `totalAmount`, `dueDate`, `link`

    **Perubahan / Change:**


15. **`invoice_paid`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Pembayaran diterima / Payment received — 36-21112026-240-431

    > Terima kasih, pembayaran invoice 36-21112026-240-431 sebesar Rp 2100000 sudah kami terima.
    > Thanks — payment for 36-21112026-240-431 (Rp 2100000) is confirmed.
    >
    > https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `invoiceNumber`, `totalAmount`, `link`

    **Perubahan / Change:**


16. **`staff_password_reset`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Atur ulang kata sandi console / Reset your console password

    > Halo Risa, admin City Storage Kebon Jeruk mengirim tautan untuk mengatur ulang kata sandi console Anda. Kata sandi lama sudah tidak berlaku. Buat yang baru melalui tautan di bawah (sekali pakai, berlaku 72 jam).
    > An administrator at City Storage Kebon Jeruk sent you a link to reset your console password. Your old password no longer works. Set a new one with the link below (single use, valid 72 hours).
    >
    > https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `displayName`, `branchName`, `link`

    **Perubahan / Change:**


17. **`booking_rejected`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Permintaan booking tidak dapat diproses / Booking request declined

    > Mohon maaf, permintaan Anda tidak dapat kami proses. Alasan: Foto KTP tidak terbaca.
    > Sorry, we couldn't process your request. Reason: Foto KTP tidak terbaca.

    *Data:* `reason`

    **Perubahan / Change:**


18. **`booking_cancelled`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Booking dibatalkan / Booking cancelled

    > Halo Budi Santoso, booking Anda telah dibatalkan dan tagihan yang belum dibayar tidak berlaku lagi. Alasan: Foto KTP tidak terbaca.
    > Hi Budi Santoso, your booking has been cancelled and its unpaid invoice no longer applies. Reason: Foto KTP tidak terbaca.

    *Data:* `customerName`, `reason`

    **Perubahan / Change:**


19. **`booking_date_changed`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Tanggal mulai sewa diubah / Rental start date changed

    > Halo Budi Santoso, tanggal mulai sewa unit STORAGE-12 Anda diubah dari 2026-11-20 menjadi 2026-11-27. Tagihan baru 36-21112026-240-431 sudah diterbitkan, jatuh tempo 4 Desember 2026; tagihan lama tidak berlaku.
    > Hi Budi Santoso, the start date of your rental of unit STORAGE-12 has moved from 2026-11-20 to 2026-11-27. A new invoice 36-21112026-240-431 has been issued, due 2026-12-04; the earlier one no longer applies.
    >
    > Lihat booking / View your booking: https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `customerName`, `assetCode`, `previousStartDate`, `newStartDate`, `nextStep`, `nextStepEn`, `link`

    **Perubahan / Change:**


20. **`booking_expired`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Permintaan booking kedaluwarsa / Booking request expired

    > Permintaan Anda untuk Medium Storage kedaluwarsa karena belum diproses dalam waktu yang ditentukan. Silakan ajukan kembali.
    > Your request expired before it could be processed — please submit again.
    >
    > https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `assetTypeName`, `link`

    **Perubahan / Change:**


21. **`term_ended`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Masa sewa berakhir / Your rental term has ended

    > Masa sewa unit STORAGE-12 berakhir pada 2027-02-27. Tim kami akan memproses pengembalian deposit Anda.
    > Your rental of unit STORAGE-12 ended on 2027-02-27; our team will process your deposit refund.
    >
    > https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `assetCode`, `endDate`, `link`

    **Perubahan / Change:**


22. **`notice_confirmed`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Pemberitahuan berhenti sewa diterima / Termination notice received

    > Pemberitahuan berhenti sewa Anda efektif 2026-12-31 sudah kami catat.
    > Your termination notice effective 2026-12-31 is recorded.
    >
    > https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `noticeEffectiveDate`, `link`

    **Perubahan / Change:**


23. **`lease_suspended`** — untuk pelanggan / to the customer

    Subjek email / Email subject: Akses ditangguhkan / Access suspended — 36-21112026-240-431

    > Invoice 36-21112026-240-431 belum dibayar; akses ke unit ditangguhkan sampai pembayaran diterima.
    > Invoice 36-21112026-240-431 is unpaid; unit access is suspended until payment lands.
    >
    > https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `invoiceNumber`, `link`

    **Perubahan / Change:**


24. **`invoice_reminder_h{n} — n hari sebelum jatuh tempo / n days before the due date`** — untuk pelanggan / to the customer

    *Contoh untuk satu nilai n; kalimatnya sama untuk setiap n. / One value of n shown; the wording is the same for every n.*

    Subjek email / Email subject: Pengingat pembayaran / Payment reminder — 36-21112026-240-431

    > Invoice 36-21112026-240-431 sebesar Rp 2100000 akan jatuh tempo. Mohon dibayar tepat waktu.
    > Invoice 36-21112026-240-431 (Rp 2100000) is coming due.
    >
    > Bayar / Pay: https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `invoiceNumber`, `totalAmount`, `link`

    **Perubahan / Change:**


25. **`invoice_overdue_d{n} — n hari setelah jatuh tempo / n days after the due date`** — untuk pelanggan / to the customer

    *Contoh untuk satu nilai n; kalimatnya sama untuk setiap n. / One value of n shown; the wording is the same for every n.*

    Subjek email / Email subject: Invoice terlambat / Overdue — 36-21112026-240-431

    > Invoice 36-21112026-240-431 sudah lewat jatuh tempo 3 hari. Mohon segera dibayar.
    > Invoice 36-21112026-240-431 is 3 days overdue — please pay as soon as possible.
    >
    > Bayar / Pay: https://sewa.citystorage.co.id/m/8f2c1a

    *Data:* `invoiceNumber`, `daysOverdue`, `link`

    **Perubahan / Change:**


26. **`invoice_reminder_h{n}_admin — salinan untuk admin cabang / the branch admin's copy`** — untuk staf / to staff

    *Contoh untuk satu nilai n; kalimatnya sama untuk setiap n. / One value of n shown; the wording is the same for every n.*

    Subjek email / Email subject: Pengingat internal / Internal reminder — 36-21112026-240-431

    > Pengingat internal: invoice 36-21112026-240-431 sebesar Rp 2100000 jatuh tempo dalam 3 hari.
    > Internal reminder: invoice 36-21112026-240-431 (Rp 2100000) is due in 3 day(s). Check the console for details.

    *Data:* `daysOverdue`, `daysUntilDue`, `invoiceNumber`, `totalAmount`

    **Perubahan / Change:**


27. **`invoice_overdue_d{n}_admin — salinan untuk admin cabang / the branch admin's copy`** — untuk staf / to staff

    *Contoh untuk satu nilai n; kalimatnya sama untuk setiap n. / One value of n shown; the wording is the same for every n.*

    Subjek email / Email subject: Invoice terlambat / Overdue — 36-21112026-240-431

    > Perhatian: invoice 36-21112026-240-431 sudah lewat jatuh tempo 3 hari.
    > Attention: invoice 36-21112026-240-431 is 3 day(s) overdue. Check the console for details.

    *Data:* `daysOverdue`, `daysUntilDue`, `invoiceNumber`

    **Perubahan / Change:**


28. **`auto_reply — balasan otomatis saat pelanggan mengirim pesan ke nomor sistem / the automatic reply when a customer writes to the system number`** — untuk pelanggan / to the customer

    *Teks bawaan; dapat diubah di Pengaturan → Pesan, dan hanya terkirim bila balasan otomatis dinyalakan. / The default text; editable in Settings → Messaging, sent only while the auto-reply is on.*

    > Halo! Nomor ini hanya untuk notifikasi otomatis (kontrak, invoice, pengingat). Untuk pertanyaan, hubungi CS City Storage Kebon Jeruk: WA +62 811-1111-838 · Tel 021-300 67838.
    >
    > Hello! This number only sends automatic notifications (contracts, invoices, reminders). For questions, please contact City Storage Kebon Jeruk CS: WA +62 811-1111-838 · Tel 021-300 67838.

    *Data:* `branchName`, `branchContact`, `branchWhatsapp`, `branchPhone`, `allBranches`

    **Perubahan / Change:**

