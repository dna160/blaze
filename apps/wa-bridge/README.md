# wa-bridge — WhatsApp linked device for RentOS

RentOS's WhatsApp transport, taken from Project Smile. The organization's own
WhatsApp number is linked to this service as a **linked device** (the mechanism
WhatsApp Web uses), through [whatsmeow](https://github.com/tulir/whatsmeow).
You don't need a Meta app, Business verification, or template approval: RentOS
sends the same bilingual text a person would type.

```
apps/api  ──┐  POST /instances/{org}/send   ┌──────────────┐      WhatsApp
apps/worker ┼──────────────────────────────▶│  wa-bridge   │◀────▶ (linked device
            │  GET  /instances/{org}         │  whatsmeow   │       of the org's
console ────┘  POST /instances/{org}/pair    └──────┬───────┘       own number)
   ▲                                                │ POST signed events
   └── apps/api /api/notifications/wa-bridge/webhook ◀┘ (inbound, receipts)
```

## What it does, and what it doesn't

- It holds one session per organization. The instance id is the organization id,
  so all of an organization's branches send from its one number (#40).
- **Sends** plain text. A send blocks until WhatsApp's server accepts the message.
  Sends are paced per number: at least `WA_BRIDGE_MIN_GAP_MS` between two sends,
  plus jitter and a brief "typing…" indicator. There is also a daily cap. Pacing
  matters because a burst of identical messages is what gets a linked device
  banned, and RentOS's batch jobs (invoice issue, dunning) send in bursts.
- It checks each recipient is on WhatsApp first (cached for a day). A number
  that isn't comes back as a per‑recipient `not_on_whatsapp` error, so it doesn't
  trip the whole channel.
- **Never queues.** If the phone is offline or the session is gone, the send
  fails immediately with a channel‑wide error, and RentOS records it as `FAILED`.
  A reminder delivered hours late is worse than a visible failure.
- **Inbound** 1:1 messages and delivery/read receipts are POSTed to RentOS, signed
  `X-Bridge-Signature: sha256=HMAC(WA_BRIDGE_TOKEN, body)`. A message is acked to
  WhatsApp only after RentOS answers 2xx. Otherwise WhatsApp redelivers it.
- It ignores groups, status updates, channels, and messages the phone itself sent.
- It has no business logic. Which message goes to whom, and when, is decided by
  RentOS's triggers in `apps/api` and `apps/worker`.

Sessions (Signal keys) live in Postgres schema `wa`, next to RentOS but outside
Prisma's `public` schema. Restarting the bridge or redeploying it doesn't unlink
the number.

## API

Every route except `/healthz` needs `Authorization: Bearer $WA_BRIDGE_TOKEN`.

| Route | Body | Returns |
|---|---|---|
| `GET /healthz` | | `{ok}` |
| `GET /instances/{id}` | | `{state, phone, pushName, pairCode?, pairExpiresAt?, sentToday, dailyCap, detail?}` |
| `POST /instances/{id}/pair` | `{phone}` | `{code, expiresAt}`: the 8‑character code, valid for about 160 s |
| `POST /instances/{id}/logout` | | status |
| `POST /instances/{id}/send` | `{to, text}` | `{id}` (the WhatsApp message id) |
| `POST /instances/{id}/read` | `{ids}` | `{ok}` |

Errors are `{error, code, channelWide}`:

| HTTP status | Codes |
|---|---|
| 409 | `not_paired`, `logged_out`, `replaced`, `banned` |
| 503 | `disconnected` |
| 429 | `daily_cap` |
| 422 | `not_on_whatsapp` |
| 400 | `bad_recipient` |

States are `unpaired → pairing → connecting → connected`. From `connected`, a
session can go to `disconnected` (whatsmeow reconnects on its own), `logged_out`
(the phone unlinked it), `replaced` (another client took the session) or
`banned`.

## Configuration

| Variable | Default | |
|---|---|---|
| `WA_BRIDGE_TOKEN` | required | ≥ 32 chars; the same value on apps/api and apps/worker |
| `WA_BRIDGE_DATABASE_URL` | `DATABASE_URL` | Postgres role allowed to create schema `wa` |
| `WA_BRIDGE_WEBHOOK_URL` | unset (events dropped) | `http://<api>/api/notifications/wa-bridge/webhook` |
| `PORT` | `4200` | |
| `WA_BRIDGE_MIN_GAP_MS` | `3000` | spacing between sends on one number |
| `WA_BRIDGE_DAILY_CAP` | `1000` | sends per number per day |
| `WA_BRIDGE_DEFAULT_COUNTRY_CODE` | `62` | for numbers written `08…` |
| `WA_BRIDGE_LOG_LEVEL` | `WARN` | whatsmeow log level |

Run exactly **one** replica. Two processes holding the same device would knock
each other off with `StreamReplaced`. Keep it on the private network only.

## Develop

```bash
cd apps/wa-bridge
go test ./...
WA_BRIDGE_TOKEN=$(openssl rand -hex 32) \
WA_BRIDGE_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/rentos?sslmode=disable" \
WA_BRIDGE_WEBHOOK_URL=http://localhost:4000/api/notifications/wa-bridge/webhook \
go run .
```

## Operating notes

- The phone stays the primary device. If it hasn't been online for about 14 days,
  WhatsApp unlinks every companion, and the state becomes `logged_out`. Pair it
  again from the console.
- This is the unofficial linked‑device protocol, not Meta's Business API.
  WhatsApp can ban numbers that send unsolicited bulk messages. RentOS only sends
  transactional messages to its own customers, and the pacing and cap are there
  to keep it that way. Don't raise them to run campaigns.
- Bump `go.mau.fi/whatsmeow` regularly (`go get go.mau.fi/whatsmeow@latest`).
  WhatsApp's protocol moves, and a `ClientOutdated` state means a rebuild is
  overdue.
