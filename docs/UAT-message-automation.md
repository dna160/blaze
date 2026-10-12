# RentOS — UAT: message automation end to end

**Paste this entire file to Claude Cowork as the opening prompt.** It is written to be
self-contained: Cowork needs no other context.

---

## 0. Your role

You are running a **User Acceptance Test** of the WhatsApp message automation in a
production system called RentOS. You have Claude in Chrome, so you drive the real web
apps in the browser, and a real phone number receives the messages.

You are testing, not building. **Do not change code, do not push WhatsApp templates, do
not edit the messaging credentials, do not delete any data.** If a test fails, record it
and move to the next one; do not try to fix it.

**Record for every test:** the test ID, exactly what you did, what you expected, what
actually happened, PASS or FAIL, and **the UTC timestamp of the action**. Timestamps are
not optional — the engineer cross-checks each one against the server logs, and a test
without a timestamp cannot be verified. Local time in Jakarta (WIB) is UTC+7. Quote any
error text **verbatim**, including error codes. Screenshot anything that looks wrong.

---

## 1. What RentOS is

RentOS is a multi-tenant rental-operations platform. The live tenant is a
self-storage business in Jakarta: customers rent a storage unit for a term of
1, 3, 6 or 12 months.

The business runs on **WhatsApp**, not email. Every step of a rental sends the customer
a WhatsApp message, and customers reply in WhatsApp. That messaging chain is what you
are testing.

**The happy path a customer walks:**

1. Customer picks a branch and a unit size on the public **storefront** and submits a
   booking request with their phone number. → gets a WhatsApp confirmation.
2. Staff see it in the **console** under *Approval Workbench* and approve it. → customer
   gets a WhatsApp message with a link.
3. Staff request identity verification (KYC). → customer gets a WhatsApp link that
   **signs them in with one tap — no password, no OTP code**, landing on the upload page.
4. Customer uploads their KTP (Indonesian ID) and a selfie. Staff review it.
5. Staff generate the rental agreement and a proforma invoice. → customer gets a
   WhatsApp message with the amount, the due date and a payment link.
6. Customer pays by bank transfer and uploads the proof. Staff verify it. → customer
   gets a WhatsApp payment confirmation.

Separately, when a customer sends a WhatsApp message to the business number, the system
**auto-replies** and the conversation shows up in the console's **Messages** inbox, where
staff can read and answer it like a normal chat app.

### Architecture, so error messages make sense

- **API** — NestJS, at `https://rentosapi-production.up.railway.app/api`
- **Console** (staff) — Next.js, `https://rentosconsole-production.up.railway.app`
- **Storefront** (customers) — Next.js, `https://rentosstorefront-production.up.railway.app`
- **Worker** — background jobs (recurring invoices, dunning reminders, renewal offers)
- Postgres with row-level security per tenant; Redis for the job queue
- Hosted on Railway. Tenant slug for every request: **`city-storage-kebon-jeruk`**
- WhatsApp goes out through the **Meta WhatsApp Cloud API**

---

## 2. Test data

| | |
|---|---|
| **Test customer phone** | **+6282166920588** — every message in this UAT must land on this number. You need the handset (or WhatsApp Web for it) in front of you. |
| Customer name to use | `UAT Oktober` |
| Business WhatsApp number | the number in the console under Settings → Messaging |
| Console login | ask the user — they have the admin account. Chrome may have it saved. |
| Tenant slug | `city-storage-kebon-jeruk` |

Use a **start date at least 7 days in the future** for every booking, and the smallest
unit size, so you don't collide with real inventory.

---

## 3. What is already known — do not re-litigate these

Read this so you don't report known conditions as new failures.

- **`otp_code` is blocked by Meta** and will not be approved. Meta refuses the
  AUTHENTICATION template category on this account (error code 10, subcode 2388185).
  Sign-in therefore uses a **magic link** (`login_link`) instead of a 6-digit code.
  **Do not test OTP. Do not try to make OTP work.**
- **21 of 22 WhatsApp templates were created successfully** on the current account.
  Created is not the same as approved — Meta reviews each one. **Checking their approval
  status is test A3 below, and it gates most of this UAT.**
- **Online card/VA payment (Xendit) is not configured.** Payment is therefore manual:
  the customer uploads a transfer proof and staff verify it. This is expected.
- **The API has no persistent disk.** Uploaded KYC documents and generated contract PDFs
  are erased when the service redeploys. A missing *old* document is expected; a document
  you upload and immediately view must work.
- Inbound WhatsApp was confirmed reaching the server at **05:30 UTC on 12 Oct 2026**, so
  the webhook path works at least as far as the server accepting Meta's delivery.

---

## 4. Two rules that explain most messaging failures

**Rule 1 — templates vs. free text.** A business may send a customer a pre-approved
**template** at any time. It may send **free-form text** only within **24 hours** of that
customer's last inbound message. All six lifecycle messages are templates. The
**auto-reply** and the **console reply** are free text, so they only work inside the
24-hour window.

**Practical consequence: do Group B first.** Sending a message from the test handset
opens the 24-hour window, and the rest of the UAT runs inside it.

**Rule 2 — a template must be APPROVED by Meta before it can be sent.** Sending a
template that is still in review fails with error **132001**. If A3 shows templates still
pending, the Group C tests will fail for that reason and not because the application is
broken. Say so clearly in your report rather than marking the feature broken.

---

## 5. The tests

### Group A — Preconditions (no WhatsApp messages expected)

**A1 — Console sign-in.** Open `https://rentosconsole-production.up.railway.app`, sign in
as admin. *Expect:* the console loads with a left sidebar: Catalog Setup, Approval
Workbench, Swap Requests, KYC Review, Inventory, Clients, Messages, Finance, Deposits,
Reports, API Access, OTA Sync, Automation, and (admin only) Users & Roles, Messaging.
Note any red number badges on *Approval Workbench* and *Messages* — record the starting
values, since later tests check they change.

**A2 — Messaging configuration.** Go to **Settings → Messaging**. *Expect:* provider is
**WhatsApp Cloud API**; **Phone Number ID = `1374331839095298`**; **WhatsApp Business
Account ID = `895129193550372`**; an access token is stored (shown masked); an app secret
is stored; a webhook verify token is stored. **Critically: is "auto-reply" enabled, and
is there auto-reply text?** If auto-reply is off or the text is empty, **no auto-reply
will ever be sent** — record that and say so prominently, because test B1 then fails by
configuration, not by defect. Record the auto-reply text verbatim so B1 can compare.
**Do not change any value here.**

**A3 — Template approval status (gates Group C).** Open
`https://business.facebook.com/wa/manage/message-templates/` and select the WhatsApp
Business Account **895129193550372**. List **every** template with its status. *Expect:*
~21 templates, most **APPROVED**. Specifically report the status of: `booking_received_basic`,
`booking_approved`, `booking_approved_payment_link`, `kyc_requested`,
`contract_proforma_ready`, `invoice_paid`, `booking_rejected`, `login_link`. If
`login_link` is absent or pending, Group D will fail for that reason. `otp_code` being
absent or rejected is expected and is not a failure.

**A4 — Webhook subscription.** In Meta → your app → WhatsApp → Configuration. *Expect:*
callback URL is
`https://rentosapi-production.up.railway.app/api/notifications/whatsapp/webhook`, and the
**`messages`** field is subscribed (ticked). Record the API version shown.

---

### Group B — Inbound and auto-reply. **Run this group first.**

**B1 — Inbound message and auto-reply.** From the handset **+6282166920588**, send
`UAT B1 inbound test` to the business WhatsApp number. Note the UTC time you sent it.
*Expect:* within ~15 seconds an automatic reply arrives on the handset, matching the
auto-reply text you recorded in A2. *If A2 showed auto-reply disabled, expect no reply —
record that as "blocked by configuration", not a defect.*

**B2 — Conversation reaches the inbox.** In the console, open **Messages**. *Expect:* a
conversation for +6282166920588 at the top, showing your B1 text as the latest message,
your WhatsApp profile name, and a timestamp. The red badge on *Messages* in the sidebar
should have increased by 1 against the A1 baseline. The list refreshes itself about every
10 seconds — wait rather than reloading.

**B3 — Opening the thread marks it read.** Click the conversation. *Expect:* the full
thread opens; the sidebar badge on *Messages* drops (by at least the 1 from B2); and on
the handset your B1 message shows **blue double ticks** (a read receipt sent by the
server). The blue ticks are the real assertion here.

**B4 — Staff reply reaches the handset.** Type `UAT B4 reply from console` in the
composer and send. Note the UTC time. *Expect:* it appears immediately in the thread as
an outgoing message; it arrives on the handset within seconds; and its status glyph in
the console progresses from sent → delivered → read as you read it on the handset
(watch for ~30 seconds; the thread refreshes about every 5 seconds).

**B5 — Inbound image.** From the handset, send a photo with the caption `UAT B5 photo`.
*Expect:* it appears in the console thread, identifiably as an image, with the caption.
Whether the image renders inline or shows as an attachment reference — record exactly what
you see.

**B6 — Replying to an unknown number.** Still in Messages, confirm whether the composer
is enabled or disabled, and whether any notice about the 24-hour window is shown. Just
record the behaviour.

---

### Group C — Booking lifecycle templates

Each step names the message that must arrive on **+6282166920588**. Record the arrival
time of each, and quote the first line so wording and the filled-in values can be checked.
Every one of these messages is bilingual: an Indonesian line, then an English line.

**C1 — Submit a booking.** Open `https://rentosstorefront-production.up.railway.app`,
pick the branch, pick the smallest unit size, choose a term of **3 months**, a start date
**at least 7 days out**, then enter name `UAT Oktober` and phone `+6282166920588`, and
submit. *Expect in the browser:* a confirmation with a link to track the booking.
*Expect on the handset:* a message beginning
`Halo UAT Oktober, permintaan booking Anda untuk ... sudah kami terima` — your name and
the start date filled in, and a tracking link. **A raw UUID, the literal text
`{{1}}`, or the word `undefined` anywhere in the message is a FAIL — quote it exactly.**

**C2 — It reaches the Approval Workbench.** In the console, open **Approval Workbench**.
*Expect:* the new booking for `UAT Oktober`, and the red sidebar badge on *Approval
Workbench* increased by 1 against your A1 baseline.

**C3 — Approve it.** Open the booking and approve it, assigning a unit if asked. Note the
UTC time. *Expect on the handset* one of two messages, depending on how this tenant is
configured — record which: either `Halo UAT Oktober, permintaan Anda disetujui` with a
verification link, or `Halo UAT Oktober, booking Anda disetujui` naming an invoice number
and a rupiah amount with a payment link. Check the rupiah amount is a sensible number and
not `0`, `NaN` or `undefined`. Also check the badge on *Approval Workbench* went back down.

**C4 — The link signs the customer in with no code.** On the **handset**, tap the link in
the C3 message. *Expect:* the storefront opens and the customer is **already signed in** —
no OTP, no password, no code to type — landing on their portal or the KYC upload page.
This one-tap sign-in is a headline feature; if it asks for a code, that is a FAIL.

**C5 — Request KYC.** Back in the console booking page, use the action that sends the KYC
request. Note the UTC time. *Expect on the handset:* a message beginning
`Halo UAT Oktober, mohon unggah foto KTP dan selfie Anda`, with an upload link.

**C6 — Customer uploads documents.** Tap the C5 link on the handset and upload two
images as the KTP and the selfie (any photo will do — this is a test). *Expect:* the
upload reports success.

**C7 — Staff review the documents.** In the console, open **KYC Review**. *Expect:* the
two documents for `UAT Oktober`, each viewable (the image opens). Approve them.
*Expect on the handset:* **no message** — KYC approval deliberately sends nothing. A
message arriving here is a finding worth reporting.

**C8 — Generate the contract and proforma invoice.** On the console booking page, use the
action that generates the rental agreement and proforma invoice. Note the UTC time.
*Expect on the handset:* a message beginning `Halo UAT Oktober, kontrak sewa dan proforma
invoice ... sudah siap`, containing **an invoice number, a rupiah amount, a payment due
date, and a unit code**, plus a payment link. Check all four values are real — a blank
due date or a missing unit code is a FAIL. Also confirm the console offers the contract
PDF, and that opening it works.

**C9 — Pay and confirm.** Tap the payment link on the handset, and in the customer portal
upload a payment proof image for that invoice. Then in the console go to **Finance**,
open that invoice, view the uploaded proof, and **verify** the payment. Note the UTC time.
*Expect on the handset:* a message beginning `Terima kasih UAT Oktober, pembayaran invoice
... sudah kami terima`, with the invoice number, the amount, and a receipt link.
*Expect in the console:* the invoice now reads as paid.

**C10 — The rejection path.** Submit a **second** booking exactly as in C1 (same phone,
same name). When it appears in the Approval Workbench, **reject** it with the reason
`UAT rejection test`. Note the UTC time. *Expect on the handset:* a message beginning
`Halo UAT Oktober, mohon maaf, permintaan booking Anda tidak dapat kami proses`, and
**containing the reason text you typed**. A missing or placeholder reason is a FAIL.

---

### Group D — Magic-link sign-in

**Skip this group and say so if A3 showed `login_link` is not APPROVED.**

**D1 — Request a sign-in link.** Open the storefront's login page
(`https://rentosstorefront-production.up.railway.app/login`) in a **logged-out** window
(use a fresh incognito window). Enter `+6282166920588` and request a sign-in link. Note
the UTC time. *Expect in the browser:* a neutral confirmation that a link was sent.
*Expect on the handset:* a message beginning `Halo UAT Oktober, berikut tautan untuk masuk
ke akun sewa Anda`, saying the link is valid for 15 minutes.

**D2 — The link works.** Tap it on the handset. *Expect:* signed in to the customer
portal, showing the bookings made in Group C.

**D3 — Rate limiting.** Immediately request another link for the same number. *Expect:*
the browser shows **the same neutral confirmation**, but **no second WhatsApp message
arrives** (there is a one-per-minute cooldown). The response being identical is the point
of the test — a different response here is a FAIL.

**D4 — An unknown number is indistinguishable.** Wait at least 70 seconds, then request a
link for a number that has never rented, such as `+6281100000000`. *Expect:* **exactly the
same** neutral confirmation as D1, with no hint that the number is unknown. Any message
like "number not found" is a **security FAIL** — quote it exactly.

**D5 — Reissue invalidates the previous link.** Wait 70 seconds, request a fresh link for
+6282166920588, then go back and tap the **older** D1 link. *Expect:* the old link is
**rejected**. If the old link still signs you in, that is a FAIL.

---

### Group E — Robustness

**E1 — A phone number with no WhatsApp account.** Submit a booking as in C1 but with the
phone `+6281100000001`. *Expect:* the storefront still confirms the booking normally and
the console still shows it in the Approval Workbench. The message simply cannot be
delivered. Nothing should error out or hang in the UI. (The engineer verifies the failed
send in the logs.)

**E2 — The console under a normal load of chatter.** Send three messages in quick
succession from the handset. *Expect:* all three appear in the thread, in the right order,
with no duplicates. Duplicates would mean the delivery de-duplication is broken.

---

## 6. How to report back

Give a table first:

| Test | Result | UTC time | Note |
|------|--------|----------|------|
| A1 | PASS | 09:14 | badges: Approvals 0, Messages 2 |
| … | | | |

Then, for every **FAIL** or anything surprising, a short paragraph: what you did, what you
expected, what happened, the verbatim error text, and a screenshot.

Finally, answer these four questions directly, because they are what this UAT exists to
settle:

1. **Does a message sent to the business number get an automatic reply?** (B1)
2. **Does that conversation appear in the console, and can staff reply to it from there?** (B2, B4)
3. **Does every step of the booking lifecycle send the right WhatsApp message, with the right values filled in?** (C1–C10)
4. **Does the one-tap sign-in link work, so a customer never needs a code?** (C4, D1–D2)

---

## 7. Guardrails

- **Never** change anything under Settings → Messaging.
- **Never** create, edit, submit or delete a WhatsApp template in Meta's tools. A3 is
  read-only.
- **Never** delete a booking, invoice, customer or document.
- Do not test OTP, and do not try to get the AUTHENTICATION template category approved.
- If a page errors or hangs, reload once, then record the failure and move on. Do not
  retry the same failing action repeatedly.
- If you are blocked on something only the user can do (a login, a Meta permission
  prompt), stop and ask them rather than working around it.
