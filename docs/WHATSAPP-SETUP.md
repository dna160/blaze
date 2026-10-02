# WhatsApp Business setup — plug and play

Everything needed to take RentOS from `console_log` to real WhatsApp, in order.
Meta business verification is the long-lead item and is assumed done.

The messages themselves are defined in
[`packages/domain/src/comms/whatsapp-templates.ts`](../packages/domain/src/comms/whatsapp-templates.ts)
— one registry that both senders and the registration script read, so what Meta
holds and what we send cannot drift.

---

## 0. What you need from Meta

Business verification is necessary but not sufficient. Before any of the values
below exist you also need, in **developers.facebook.com**:

- An **app** of type Business with the **WhatsApp** product added.
- A **real sending number** added under WhatsApp → API Setup. The test number Meta
  gives you can only message numbers on its allow-list, so it cannot carry
  production traffic. A number already signed in to the WhatsApp or WhatsApp
  Business *app* must be deleted from there first, or Meta refuses to register it.
- A **payment method** on the WhatsApp Business Account. Verification alone does
  not let you message arbitrary numbers; check WhatsApp Manager → Billing, because
  this is the usual reason a correctly configured number still won't send.

Then, from **your app → WhatsApp → API Setup**:

| Value | Where | Used as |
|---|---|---|
| Phone number ID | API Setup, under the sending number | saved in the console |
| WhatsApp Business Account ID (WABA) | API Setup | saved in the console, and `--waba` for the template script |
| Permanent access token | Business Settings → System Users → generate token, scopes `whatsapp_business_messaging` + `whatsapp_business_management` | saved in the console |
| App Secret | App Settings → Basic → App Secret | `WHATSAPP_APP_SECRET` |

Use a **System User** token, not a user token: user tokens expire and take
messaging down with them.

---

## 1. Environment variables

Two secrets you generate yourself:

```bash
openssl rand -hex 32     # MESSAGING_CONFIG_KEY  (exactly 64 hex chars)
openssl rand -hex 24     # WHATSAPP_WEBHOOK_VERIFY_TOKEN (any opaque string)
```

### `@rentos/api`

| Variable | Value | Why |
|---|---|---|
| `MESSAGING_CONFIG_KEY` | the 64-hex key | AES-256-GCM key sealing the access token at rest. **Without it the console refuses to save a token** (`canStoreSecrets: false`). |
| `STOREFRONT_BASE_URL` | e.g. `https://rentosstorefront-production.up.railway.app` | Every message carries a magic link. Links fall back to the tenant's primary domain, then this, then `http://localhost:3000` — so if this is unset and no real domain is registered, **every link you send is dead**. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | the opaque string | Meta's GET handshake when you save the callback URL. |
| `WHATSAPP_APP_SECRET` | App Secret | Verifies `X-Hub-Signature-256` on every delivery. Unset = webhook rejects everything, by design. |

### `@rentos/worker`

Dunning reminders, renewal offers and term-end notices are sent by the worker, in
its own process — it needs its own copy or those messages silently degrade to a
log line.

| Variable | Value |
|---|---|
| `MESSAGING_CONFIG_KEY` | **the same value as the API** |
| `STOREFRONT_BASE_URL` | same as the API |

> `MESSAGING_PROVIDER` is only the fallback for a deployment with no console
> config. Leave it at `console_log`; the per-organization setting overrides it.

---

## 2. Register the templates

**Do this before touching the console.** WhatsApp will not send free-form
business-initiated messages — every one must be a template Meta has approved —
and the console's "Send a test message" button sends the `otp_code` *template*.
Until that template exists and is approved, the test fails with a template error
that looks exactly like bad credentials.

There are 22.

```bash
pnpm wa:templates print     # markdown, for entering by hand
pnpm wa:templates push      # create every missing one via the Graph API
pnpm wa:templates status    # what Meta holds; exits non-zero if any is missing or unapproved
```

`push` and `status` need:

```bash
export WHATSAPP_BUSINESS_ACCOUNT_ID=...   # or --waba <id>
export WHATSAPP_CLOUD_TOKEN=...           # or --token <token>
```

`push` never edits or deletes: a name that already exists is reported as
`exists` and left alone. Approval is Meta's call, usually minutes. Re-run
`status` until it is clean — a template that is missing or unapproved means those
messages fail at send time.

### About the parameters

Template bodies are positional (`{{1}}`, `{{2}}`…). The registry declares each
template's parameters **by name, in order**, and the senders fill them by name —
so the wire format is a property of the registry, not of whichever call site
happens to be sending. `packages/domain/test/whatsapp-callsites.test.ts` asserts
every call site still satisfies its template; if you add a message, add a case
there too.

Two consequences worth knowing:

- A missing or blank parameter **throws** rather than sending a message with a
  hole in it. The failure lands on the `notifications` row (`status = FAILED`,
  `error` naming the parameter).
- Newlines, tabs and runs of spaces inside a parameter are collapsed, because
  Meta rejects them. Customer names and rejection reasons are free text.

`otp_code` is Meta's **AUTHENTICATION** category: Meta owns the body wording, and
the code is echoed into a copy-code button. Sending a passcode through a UTILITY
template gets the template rejected or the number flagged.

### When `push` fails on every template

All 22 failing identically means the cause is the account or the request shape,
not the copy. The script prints Meta's full error object and the rejected request
beside the first failure — read `error_user_msg`, not `message`, which is always
the generic "Invalid parameter".

**`WABA not allowed to manage templates` (code 100, subcode 2494160).** Meta is
refusing on account state; nothing in this repo can fix it, and a new token will
not help. Note that `status` succeeding proves the token's
`whatsapp_business_management` scope is fine — reads work, writes are blocked, so
the restriction belongs to the WABA. Work through, in order:

1. **Try creating one template by hand**, WhatsApp Manager → Account tools →
   Message templates → Create template. The UI explains the block far better than
   the API does, usually with a link straight to the remedy. If the UI also
   refuses, everything below is the likely cause; if it succeeds, re-run `push`.
2. **Attach a payment method** — WhatsApp Manager → Billing. The most common
   cause, and Meta reports it as a template restriction rather than a billing
   one. Business verification does not cover this.
3. **Check whether the number is Meta's test number.** A test WABA, created
   automatically with the app, is limited. A real sending number added under
   WhatsApp → API Setup is what carries production traffic.
4. **Check who owns the WABA** — Business Settings → Accounts → WhatsApp
   Accounts. If a BSP or partner owns it (common when it was created through an
   embedded-signup or agency flow), only they can manage templates, and the fix
   is to have it transferred or to have them register these for you.
5. **Look for restrictions on the WABA itself** on the same screen — a policy
   flag or an incomplete onboarding step blocks template management while
   leaving reads working, which is exactly the shape of this error.

---

## 3. Save the credentials in the console

Once `pnpm wa:templates status` reports `otp_code` APPROVED:

**Console → Settings → Messaging** (admin only):

1. **Sending** → "On — send via WhatsApp Cloud API"
2. Phone number ID, WhatsApp Business account ID, permanent access token
3. **Send a test message** to your own number *before* saving — the test uses the
   credentials typed in the form rather than the stored ones, so it proves them
   first. Success reads "Delivered. Meta message id …"
4. **Save**

The banner at the top of that page tells you what is actually in force:
"Not sending — logging only" (nothing configured), "Using deployment credentials"
(falling back to env vars), or "Using your saved number". If you instead see an
amber warning about `MESSAGING_CONFIG_KEY`, step 1 was not applied — saving a
token will be refused.

Credentials live on the **Organization**, so one number serves every branch, and
the screen only ever shows the last 4 characters of a saved token.

---

## 4. Point Meta's webhook at the API

Without this, a notification goes to `SENT` the moment Meta *accepts* the call and
never moves again — so a message Meta accepted and then failed to deliver reads as
delivered forever.

In **your app → WhatsApp → Configuration → Webhook**:

- **Callback URL**: `https://<your-api-domain>/api/notifications/whatsapp/webhook`
  (production today: `https://rentosapi-production.up.railway.app/api/notifications/whatsapp/webhook`)
- **Verify token**: the `WHATSAPP_WEBHOOK_VERIFY_TOKEN` you set
- **Subscribe to**: `messages` (covers both delivery statuses and inbound replies)

One callback URL serves every organization: Meta allows one per app, and the
payload's `phone_number_id` is what identifies the sender, so routing happens
from the payload rather than from the URL.

What it does:

| Meta says | `notifications.status` becomes |
|---|---|
| `delivered` | `DELIVERED` |
| `read` | `READ` |
| `failed` | `FAILED`, with Meta's error code and detail in `error` |
| an inbound reply | a new row, `templateKey = inbound_message`, `status = RECEIVED` |

Status never goes backwards — Meta does not guarantee ordering, so a late
`delivered` cannot undo a `read` that already landed. Redelivered inbound
messages are deduplicated on Meta's message id. Inbound replies are attributed to
a customer by phone number where one matches, and recorded unattributed where
none does; **surfacing them in the console is not built yet** — this guarantees
they are not lost.

---

## 5. Verify

```bash
pnpm wa:templates status                       # every template APPROVED
```

Then, in the product:

1. Console → Settings → Messaging → **Send a test message** → arrives on your phone
2. Submit a storefront booking with your own number → `booking_received` arrives,
   and its link opens the portal **signed in** (that link is the magic link; if it
   points at `localhost`, `STOREFRONT_BASE_URL` is unset)
3. Check `notifications` — the row should reach `DELIVERED`, then `READ` once you
   open it. Still `SENT` after a minute means the webhook is not wired
4. Reply to the message on WhatsApp → a row appears with
   `template_key = 'inbound_message'`

```sql
select template_key, status, error, created_at
from notifications order by created_at desc limit 10;
```

---

## Notes

- **24-hour window.** Business-initiated messages must be templates, which is why
  everything here is one. Free-form replies are only allowed within 24 hours of
  the customer's last message.
- **One number per organization.** Per-branch numbers would mean moving
  `messagingConfig` from `Organization` to `Tenant`.
- **Egress.** Sending requires outbound access to `graph.facebook.com`.
- **Rotating the token** is a console save, not a deploy. Rotating
  `MESSAGING_CONFIG_KEY` orphans the sealed token — messages fall back to the
  environment or to `console_log` rather than failing, so re-save the credentials
  in the console after any key change.
