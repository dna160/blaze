# PRD — Messaging Inbox (receive, read, reply to WhatsApp chats in the RentOS console)

Status: **built**. See "As built" at the end for what landed and where it differs
from this brief.

## 1. Why

Once a WhatsApp number is registered on the Cloud API there is no phone app for
it: every conversation on that number can only be read and answered through the
API. RentOS already receives inbound messages (webhook → `notifications` rows
with `templateKey = "inbound_message"`, `status = "RECEIVED"`) and can send
free-form text (`MessagingProvider.sendText`) — but nothing in the console showed
those messages or let staff answer. The webhook code said so itself: *"Surfacing
it in the console is a separate piece of work — this only guarantees the message
is not lost."* This is that piece of work.

## 2. Goals / non-goals

Goals
- Staff see every WhatsApp conversation for the branches they are scoped to,
  newest activity first, with unread counts.
- Staff open a conversation, read the full thread (inbound plus everything RentOS
  sent, including auto-replies and template sends), and reply with free-form text
  when WhatsApp allows it.
- The thread is attributed to a Customer when the phone matches one; unknown
  numbers are still shown and answerable.
- Works with Meta's test number and later with the real number, unchanged.

Non-goals
- Sending media, templates, or business-initiated messages from the inbox.
  Outside the 24-hour window the composer is disabled and says why.
- Assignment of conversations between agents, typing indicators, websockets.
- Changes to how the webhook routes or stores messages beyond §5.
- Coexistence / Embedded Signup.

## 3. Data model

No new table. A **conversation** is derived: `(tenantId, counterpartPhone)` over
`notifications` where `channel = "WHATSAPP"` and `recipientRole = "CUSTOMER"`,
with the phone normalised to Meta's spelling (digits, no `+`), so `+62…` and
`62…` collapse to one thread.

One new column, migration `20261004100000_notification_read_at`:

```prisma
readAt DateTime? @map("read_at")   // null = unread; only meaningful on inbound rows
@@index([tenantId, recipient, createdAt])
```

The inbound `payload` additionally carries `profileName` (from the webhook's
`value.contacts[].profile.name`) and, for non-text messages, `mediaId` and
`caption`. Direction and kind are derived from `templateKey`, never stored.

## 4. API — `apps/api/src/messaging/`

`@Controller("messaging")`, `@UseGuards(JwtAuthGuard, StaffGuard)`. No
capability: answering a customer who wrote in is day-to-day work for every role.
Branch scope is enforced by running every statement through
`runInTenantContext` for each tenant the user's role assignments cover.

| Route | Does |
|---|---|
| `GET /messaging/conversations` | One row per `(tenant, phone)`; `q`, `unreadOnly`, `tenantId`, `cursor`, `limit`. |
| `GET /messaging/conversations/:tenantId/:phone/messages` | The thread. Marks inbound rows read and sends Meta a read receipt for the newest. |
| `POST /messaging/conversations/:tenantId/:phone/reply` | Free-form reply. `409 WINDOW_CLOSED` outside 24h; `502` passes Meta's error through verbatim. |
| `GET /messaging/unread-count` | Nav badge, across the user's branches. |

## 5. Console

`/messaging`, two panes. Left: search, unread-only toggle, branch filter when the
user spans more than one, rows with preview/time/unread pill/delivery glyph.
Right: thread grouped by day, bubbles with `SENT ✓` / `DELIVERED ✓✓` / `READ ✓✓`
in blue / `FAILED` with Meta's reason on hover, `auto_reply` captioned "Auto",
template sends captioned with their key. Composer gated on `canReply`, Enter to
send, keeps the draft on failure. Nav item "Messages" with an unread badge.
Polling: 10s list, 5s thread, 15s badge.

## 6. As built

Everything above is implemented. Where it differs from the original brief:

- **Pure helpers live in `packages/contracts`** (`normalizePhone`,
  `isReplyWindowOpen`, `messageDirection`, `messageKind`, …) rather than
  `packages/domain`, so they sit beside the schemas that describe them. `vitest`
  was added to that package to test them.
- **An out-of-scope `tenantId` returns `400 "Unknown branch"`**, the same answer
  as a tenant that does not exist, rather than zero rows. The unfiltered list
  still returns zero rows for a sibling branch as specified — this only covers a
  caller naming a branch explicitly, where silence would be a worse answer than a
  refusal that leaks nothing.
- **`markRead` was added to the `MessagingProvider` port** so the read receipt
  goes through the same registry as sends, and the console_log adapter keeps
  local development credential-free.
- Cursor pagination is applied after merging branches in memory, as §5 of the
  brief allowed.

### Verified live

Against local Postgres 16 with the API booted and a stub standing in for Graph:

- Conversation grouping collapses `+6281…` and `6281…`; `displayName` falls back
  customer name → `profileName` → null; a thread of only outbound templates still
  appears, with `lastInboundAt: null`.
- Opening a thread took unread 8 → 3, set `read_at` on 5/5 inbound rows, and sent
  Meta `{"messaging_product":"whatsapp","status":"read","message_id":"wamid.IN1"}`.
- Reply inside the window produced the correct Cloud API body (`type: "text"`,
  `recipient_type: "individual"`) and persisted `agent_reply` with `sentBy`.
- Reply outside the window returned `409 WINDOW_CLOSED` **without calling Meta**
  (stub request count unchanged); a number that never wrote in returned the same
  with `windowOpenUntil: null`.
- A Meta refusal (`131030`) surfaced as `502` with Meta's wording intact, and no
  `agent_reply` row was written for the failed send.
- A `STAFF` user scoped to one branch saw only that branch; a second branch in
  the same org was invisible to them and visible to an `ORGANIZATION`-scoped
  admin (unread 3 vs 4). Naming the sibling branch explicitly, in either the list
  or the thread route, was refused.
