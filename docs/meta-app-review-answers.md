# Meta App Review — answers

Paste-ready text for each form field. **Two placeholders you must fill in before
submitting** are marked `<<< >>>`.

---

## Q1. Instructions for accessing the app, and testing instructions
### (includes the required confirmation about Facebook Login / Meta APIs)

> RentOS is a web application. There is no mobile app, so nothing needs to be downloaded.
>
> It is a rental-operations platform used by a self-storage business in Jakarta, Indonesia.
> The business runs its customer communication on WhatsApp. There are two web surfaces:
>
> - **Customer storefront** (public, no sign-in needed to book):
>   https://rentosstorefront-production.up.railway.app
> - **Staff console** (sign-in required):
>   https://rentosconsole-production.up.railway.app
>
> ### Confirmation of Meta API use
>
> The only Meta integration in this application is the **WhatsApp Business Cloud API**.
> Our backend makes exactly one kind of Graph API call:
>
> `POST https://graph.facebook.com/v21.0/{phone-number-id}/messages`
>
> It is used for three things: sending booking and payment notifications to customers as
> approved message templates; sending staff replies as free-form text within the 24-hour
> customer service window; and sending read receipts when staff open a conversation.
>
> We also receive Meta webhooks at
> `POST https://rentosapi-production.up.railway.app/api/notifications/whatsapp/webhook`
> for inbound customer messages and for message status updates (sent / delivered / read).
>
> **Facebook Login is not integrated in this application, and never has been.** We do not
> request or use any Meta API for identity or profile data — no `email`, no `public_profile`,
> no `user_friends`, `user_gender`, `user_birthday`, or any other user permission.
>
> The reason is our market. Our customers are Indonesian storage renters who transact over
> WhatsApp, not Facebook. Customer sign-in is therefore a **WhatsApp magic link**: the
> customer enters their phone number, receives a single-use sign-in link over WhatsApp, and
> taps it — there is no password and no social login. Staff sign in with an email address and
> password issued by their employer. No social login of any kind is enabled in production.
>
> ### Testing instructions
>
> **Please note:** the feature under review sends WhatsApp messages to the customer's own
> phone. To see a message arrive, the reviewer needs to enter **their own WhatsApp number**
> in step 2. Any country code works. No message is ever sent to a number the reviewer has
> not entered themselves.
>
> **Part 1 — the customer journey (demonstrates sending a template message)**
>
> 1. Open https://rentosstorefront-production.up.railway.app
> 2. Choose the branch, then a storage unit size, then a rental term of 3 months and any
>    start date at least a week out.
> 3. Enter any name, and **the reviewer's own WhatsApp number** as the phone number. Submit.
> 4. The page confirms the booking. **Within a few seconds a WhatsApp message arrives on that
>    number**, in Indonesian and English, confirming the booking request and containing a link
>    to track it. This is the `whatsapp_business_messaging` permission in use.
> 5. Tapping that link opens the customer's own booking page. No password or code is required —
>    this is the magic-link sign-in described above.
>
> **Part 2 — the staff journey (demonstrates replying, and the message inbox)**
>
> 6. Open https://rentosconsole-production.up.railway.app and sign in with:
>    - Email: `<<< reviewer account email >>>`
>    - Password: `<<< reviewer account password >>>`
> 7. Open **Approval Workbench** in the left sidebar. The booking from step 3 is listed.
>    Open it and choose **Approve**. A second WhatsApp message arrives on the reviewer's
>    number with the next step and a link.
> 8. Still on that booking, choose **Request KYC**. A third WhatsApp message arrives asking
>    the customer to upload identity documents, with a link that signs them in directly.
> 9. From the reviewer's phone, **send any WhatsApp message to the business number
>    `<<< business WhatsApp number, e.g. +62 8xx xxxx xxxx >>>`**.
> 10. In the console, open **Messages** in the left sidebar. The conversation appears within
>     about ten seconds, with an unread count badge. Open it — the message history is shown,
>     and the message is marked as read on the reviewer's phone.
> 11. Type a reply in the box at the bottom and send it. **It arrives on the reviewer's
>     WhatsApp within seconds**, and the console shows its delivery status advance from sent
>     to delivered to read. This is free-form messaging inside the 24-hour customer service
>     window.
>
> Step 9 must come before step 11. WhatsApp only permits free-form replies within 24 hours of
> the customer's own message, so the reviewer's message in step 9 is what opens that window.
> The template messages in steps 4, 7 and 8 do not depend on it and can be tested on their own.
>
> The interface is bilingual Indonesian and English throughout, and prices are shown in
> Indonesian rupiah, as the business operates in Jakarta.

---

## Q2. Is Facebook Login integrated on this platform?

> **No**

---

## Q3. Test credentials for payment- or membership-gated functionality

> The customer storefront requires no payment, subscription or membership. Anyone can browse
> and submit a booking request without signing in, and the WhatsApp notification in step 4 of
> the testing instructions is sent to an unauthenticated visitor.
>
> The staff console requires an employee account. We have created a reviewer account that will
> remain active for at least one year from submission:
>
> - URL: https://rentosconsole-production.up.railway.app
> - Email: `<<< reviewer account email >>>`
> - Password: `<<< reviewer account password >>>`
>
> This account has the permissions needed to complete every step in the testing instructions:
> approving bookings, requesting identity verification, and reading and replying to WhatsApp
> conversations.
>
> Facebook Login is not used by this application, so no Facebook test user is applicable.

---

## Q4. Gift codes for paid app downloads

> Not applicable. RentOS is a web application accessed through a browser. It is not distributed
> through any app store, there is nothing to download, and there are no in-app purchases or
> subscriptions.

---

## Q5. Geographic restrictions, geo-blocking or geo-fencing

> There are no geographic restrictions of any kind. Both web surfaces are publicly reachable
> from any country with no geo-blocking, geo-fencing, IP allow-listing or VPN requirement, and
> reviewers need take no steps to bypass anything.
>
> WhatsApp notifications are sent to whatever phone number the customer enters, with any
> country code, so a reviewer outside Indonesia receives the messages normally.
>
> For context rather than as a restriction: the business operates in Jakarta, so the catalogue
> shows Jakarta branches, prices are in Indonesian rupiah, and the interface is bilingual
> Indonesian and English. None of this limits access.

---

# Before you submit — three things to do

**1. Create the reviewer console account** (fills both `<<< reviewer account >>>` placeholders).
In the console: **Settings → Users & Roles → invite/add a user**. Give it a role that can
approve bookings and use the Messages inbox. Use a mailbox you control, a password you don't
use anywhere else, and **do not delete the account for at least a year** — Meta may re-review.

**2. Fill in the business WhatsApp number** in step 9 (the `<<< business WhatsApp number >>>`
placeholder) — the display number for phone number ID `1374331839095298`. Without it the
reviewer cannot open the 24-hour window and step 11 will fail for them.

**3. Don't deploy during the review window.** The API has no persistent disk, so documents a
reviewer uploads at step 8 are erased by a redeploy. Nothing else in the test script is affected.

## Permissions to request

Based on what the code actually calls:

- **`whatsapp_business_messaging`** — keep. This is the only permission the deployed
  application uses, and the test script above demonstrates it.
- **`whatsapp_business_management`** — drop from this submission. No screen in the product
  reads or manages the WhatsApp account; it is used only by maintenance CLI scripts that run
  from a developer laptop, and those work under Standard Access on our own WhatsApp Business
  Account. Keep the scope on the System User, just don't submit it for review.
- **`whatsapp_business_manage_events`** — drop. Nothing in the codebase sends conversion
  events; it exists for Click-to-WhatsApp ad attribution, which we don't run.
