package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// Instance states, as reported to the console.
const (
	StateUnpaired     = "unpaired"
	StatePairing      = "pairing"
	StateConnecting   = "connecting"
	StateConnected    = "connected"
	StateDisconnected = "disconnected" // transient: whatsmeow reconnects by itself
	StateLoggedOut    = "logged_out"   // unlinked from the phone; pair again
	StateReplaced     = "replaced"     // another client took the session; never auto-retried
	StateBanned       = "banned"
)

// pairDisplayName must be `Browser (OS)`: WhatsApp rejects anything else with
// HTTP 400 (Smile PRD §11, "Pairing refused with HTTP 400").
const pairDisplayName = "Chrome (Linux)"

// pairWindow is how long WhatsApp keeps the login socket open for a code.
const pairWindow = 160 * time.Second

type Manager struct {
	cfg       Config
	db        *sql.DB
	container *sqlstore.Container
	hook      *Webhook

	mu        sync.Mutex
	instances map[string]*Instance
}

type Instance struct {
	id  string
	mgr *Manager

	mu          sync.Mutex
	client      *whatsmeow.Client
	state       string
	detail      string
	pairCode    string
	pairExpires time.Time

	send   sendState
	recent *recentInbound
}

func NewManager(cfg Config, db *sql.DB, container *sqlstore.Container, hook *Webhook) *Manager {
	return &Manager{cfg: cfg, db: db, container: container, hook: hook, instances: map[string]*Instance{}}
}

func (m *Manager) get(id string) *Instance {
	m.mu.Lock()
	defer m.mu.Unlock()
	inst, ok := m.instances[id]
	if !ok {
		inst = &Instance{id: id, mgr: m, state: StateUnpaired, recent: newRecentInbound(5000)}
		m.instances[id] = inst
	}
	return inst
}

// Restore reconnects every instance that has a paired device on record.
func (m *Manager) Restore(ctx context.Context) error {
	rows, err := m.db.QueryContext(ctx, `SELECT id, jid FROM wa.rentos_instances WHERE jid IS NOT NULL`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type pair struct{ id, jid string }
	var paired []pair
	for rows.Next() {
		var p pair
		if err := rows.Scan(&p.id, &p.jid); err != nil {
			return err
		}
		paired = append(paired, p)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for _, p := range paired {
		jid, err := types.ParseJID(p.jid)
		if err != nil {
			log.Printf("instance %s: bad stored jid %q: %v", p.id, p.jid, err)
			continue
		}
		device, err := m.container.GetDevice(ctx, jid)
		if err != nil {
			log.Printf("instance %s: load device: %v", p.id, err)
			continue
		}
		if device == nil {
			// The session was deleted (logged out while we were down).
			m.saveJID(ctx, p.id, "")
			continue
		}
		inst := m.get(p.id)
		inst.mu.Lock()
		inst.attach(device)
		inst.state = StateConnecting
		cli := inst.client
		inst.mu.Unlock()
		if err := cli.Connect(); err != nil {
			log.Printf("instance %s: connect: %v (whatsmeow keeps retrying)", p.id, err)
		}
	}
	log.Printf("restored %d paired instance(s)", len(paired))
	return nil
}

func (m *Manager) DisconnectAll() {
	m.mu.Lock()
	var clients []*whatsmeow.Client
	for _, inst := range m.instances {
		inst.mu.Lock()
		if inst.client != nil {
			clients = append(clients, inst.client)
		}
		inst.mu.Unlock()
	}
	m.mu.Unlock()
	for _, cli := range clients {
		cli.Disconnect()
	}
}

func (m *Manager) saveJID(ctx context.Context, id, jid string) {
	var value any
	if jid != "" {
		value = jid
	}
	_, err := m.db.ExecContext(ctx, `INSERT INTO wa.rentos_instances (id, jid, updated_at) VALUES ($1, $2, now())
		ON CONFLICT (id) DO UPDATE SET jid = EXCLUDED.jid, updated_at = now()`, id, value)
	if err != nil {
		log.Printf("instance %s: save jid: %v", id, err)
	}
}

// attach wires a device to a new client. Caller holds inst.mu.
func (inst *Instance) attach(device *store.Device) {
	cli := whatsmeow.NewClient(device, waLog.Stdout("wa:"+shortID(inst.id), inst.mgr.cfg.LogLevel, false))
	cli.AddEventHandlerWithSuccessStatus(inst.onEvent)
	inst.client = cli
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// Status is what GET /instances/{id} returns.
type Status struct {
	ID            string     `json:"id"`
	State         string     `json:"state"`
	Detail        string     `json:"detail,omitempty"`
	Phone         string     `json:"phone,omitempty"`
	PushName      string     `json:"pushName,omitempty"`
	PairCode      string     `json:"pairCode,omitempty"`
	PairExpiresAt *time.Time `json:"pairExpiresAt,omitempty"`
	SentToday     int        `json:"sentToday"`
	DailyCap      int        `json:"dailyCap"`
}

func (inst *Instance) Status() Status {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	s := Status{ID: inst.id, State: inst.state, Detail: inst.detail, DailyCap: inst.mgr.cfg.DailyCap}
	if inst.client != nil && inst.client.Store.ID != nil {
		s.Phone = inst.client.Store.ID.User
		s.PushName = inst.client.Store.PushName
	}
	if inst.state == StatePairing && time.Now().Before(inst.pairExpires) {
		s.PairCode = inst.pairCode
		expires := inst.pairExpires
		s.PairExpiresAt = &expires
	}
	s.SentToday = inst.send.countToday()
	return s
}

var (
	ErrAlreadyPaired = errors.New("this instance is already linked to a WhatsApp number; log it out first")
	ErrNotPaired     = errors.New("no WhatsApp number is linked to this instance; pair one from Console → Settings → Messaging")
)

// Pair starts the linked-device flow and returns the 8-character code the
// owner types into WhatsApp → Linked devices → Link with phone number.
func (inst *Instance) Pair(phone string) (string, time.Time, error) {
	inst.mu.Lock()
	if inst.client != nil && inst.client.Store.ID != nil && inst.state != StateLoggedOut {
		inst.mu.Unlock()
		return "", time.Time{}, ErrAlreadyPaired
	}
	if inst.state == StatePairing && time.Now().Before(inst.pairExpires) {
		code, expires := inst.pairCode, inst.pairExpires
		inst.mu.Unlock()
		if code == "" {
			return "", time.Time{}, errors.New("a pairing request is already being set up; try again in a few seconds")
		}
		return code, expires, nil
	}
	if old := inst.client; old != nil {
		// Never under inst.mu: Disconnect can dispatch events whose handler takes it.
		go old.Disconnect()
	}
	inst.attach(inst.mgr.container.NewDevice())
	cli := inst.client
	// Claimed with an empty code, so a second request waits instead of
	// starting another socket. The lock is not held across the network calls
	// below: event handlers for this client take it too.
	inst.state = StatePairing
	inst.detail = ""
	inst.pairCode = ""
	inst.pairExpires = time.Now().Add(pairWindow)
	inst.mu.Unlock()

	code, err := startPairing(cli, phone)
	inst.mu.Lock()
	defer inst.mu.Unlock()
	if inst.client != cli {
		return "", time.Time{}, errors.New("pairing was cancelled")
	}
	if err != nil {
		go cli.Disconnect()
		inst.state = StateUnpaired
		inst.detail = err.Error()
		return "", time.Time{}, err
	}
	inst.pairCode = code.code
	inst.pairExpires = time.Now().Add(pairWindow)
	go inst.watchPairing(cli, code.qr)
	return code.code, inst.pairExpires, nil
}

type pairing struct {
	code string
	qr   <-chan whatsmeow.QRChannelItem
}

func startPairing(cli *whatsmeow.Client, phone string) (pairing, error) {
	// GetQRChannel must precede Connect, and PairPhone must wait for the first
	// QR event: that is whatsmeow's signal that the login socket is ready.
	qr, err := cli.GetQRChannel(context.Background())
	if err != nil {
		return pairing{}, err
	}
	if err := cli.Connect(); err != nil {
		return pairing{}, fmt.Errorf("connect to WhatsApp: %w", err)
	}
	select {
	case item, ok := <-qr:
		if !ok || item.Event != whatsmeow.QRChannelEventCode {
			return pairing{}, fmt.Errorf("WhatsApp closed the login socket before pairing could start (%s)", item.Event)
		}
	case <-time.After(20 * time.Second):
		return pairing{}, errors.New("timed out waiting for WhatsApp's login socket")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	code, err := cli.PairPhone(ctx, phone, true, whatsmeow.PairClientChrome, pairDisplayName)
	if err != nil {
		return pairing{}, fmt.Errorf("WhatsApp refused the pairing request: %w", err)
	}
	return pairing{code: code, qr: qr}, nil
}

// watchPairing drains the QR channel so whatsmeow never blocks on it, and
// resets the instance when the window lapses without the code being typed.
func (inst *Instance) watchPairing(cli *whatsmeow.Client, qr <-chan whatsmeow.QRChannelItem) {
	for item := range qr {
		if item.Event == whatsmeow.QRChannelEventCode {
			continue
		}
		inst.mu.Lock()
		if inst.client == cli && inst.state == StatePairing {
			if item == whatsmeow.QRChannelSuccess {
				inst.state = StateConnecting
			} else {
				inst.state = StateUnpaired
				inst.detail = "The pairing code expired before it was entered. Generate a new one."
				go cli.Disconnect()
			}
			inst.pairCode = ""
		}
		inst.mu.Unlock()
	}
}

// Logout unlinks the device on WhatsApp's side and forgets it here.
func (inst *Instance) Logout(ctx context.Context) error {
	inst.mu.Lock()
	cli := inst.client
	inst.mu.Unlock()
	if cli != nil {
		if cli.Store.ID != nil && cli.IsConnected() {
			if err := cli.Logout(ctx); err != nil {
				log.Printf("instance %s: logout: %v", inst.id, err)
			}
		} else if cli.Store.ID != nil {
			_ = cli.Store.Delete(ctx)
		}
		cli.Disconnect()
	}
	inst.mgr.saveJID(ctx, inst.id, "")
	inst.mu.Lock()
	inst.client = nil
	inst.state = StateUnpaired
	inst.detail = ""
	inst.pairCode = ""
	inst.mu.Unlock()
	return nil
}

func (inst *Instance) setState(state, detail string) {
	inst.mu.Lock()
	changed := inst.state != state
	inst.state = state
	inst.detail = detail
	inst.mu.Unlock()
	if changed {
		go inst.mgr.hook.Deliver(ConnectionEvent{Type: "connection", InstanceID: inst.id, State: state, Detail: detail})
	}
}

// onEvent runs on whatsmeow's event goroutine. Returning false withholds the
// ack so WhatsApp redelivers; only inbound messages need that guarantee.
func (inst *Instance) onEvent(evt any) bool {
	switch e := evt.(type) {
	case *events.PairSuccess:
		inst.mgr.saveJID(context.Background(), inst.id, e.ID.ToNonAD().String())
		log.Printf("instance %s: paired as %s", inst.id, redact(e.ID.User))
	case *events.Connected:
		inst.setState(StateConnected, "")
	case *events.Disconnected:
		inst.mu.Lock()
		pairing := inst.state == StatePairing
		inst.mu.Unlock()
		if !pairing {
			inst.setState(StateDisconnected, "Reconnecting to WhatsApp.")
		}
	case *events.LoggedOut:
		inst.mgr.saveJID(context.Background(), inst.id, "")
		inst.setState(StateLoggedOut, "The phone unlinked this device. Pair the number again.")
	case *events.StreamReplaced:
		inst.setState(StateReplaced, "Another WhatsApp Web session using this device took over. Restart the bridge or pair again.")
	case *events.TemporaryBan:
		inst.setState(StateBanned, e.String())
	case *events.ClientOutdated:
		inst.setState(StateDisconnected, "WhatsApp says this client is outdated: rebuild the bridge with a newer whatsmeow.")
	case *events.Message:
		return inst.onMessage(e)
	case *events.Receipt:
		inst.onReceipt(e)
	}
	return true
}

func (inst *Instance) onMessage(e *events.Message) bool {
	info := e.Info
	if info.IsFromMe || info.IsGroup || info.Chat.Server == types.BroadcastServer || info.Chat.Server == types.NewsletterServer {
		return true
	}
	kind, text := describe(e.Message)
	if kind == "" {
		return true // reactions, edits, protocol noise
	}

	from, fromLID := inst.phoneOf(info.Sender, info.SenderAlt)
	inst.recent.put(info.ID, info.Chat, info.Sender)
	return inst.mgr.hook.Deliver(MessageEvent{
		Type:       "message",
		InstanceID: inst.id,
		ID:         info.ID,
		From:       from,
		FromLID:    fromLID,
		PushName:   info.PushName,
		Timestamp:  info.Timestamp,
		Kind:       kind,
		Text:       text,
	})
}

// phoneOf prefers the phone-number JID over a LID, which is what RentOS
// stores customers by (Smile's ingest.PreferPN).
func (inst *Instance) phoneOf(sender, alt types.JID) (string, bool) {
	if sender.Server == types.DefaultUserServer {
		return sender.User, false
	}
	if alt.Server == types.DefaultUserServer {
		return alt.User, false
	}
	if sender.Server == types.HiddenUserServer {
		inst.mu.Lock()
		cli := inst.client
		inst.mu.Unlock()
		if cli != nil {
			if pn, err := cli.Store.LIDs.GetPNForLID(context.Background(), sender.ToNonAD()); err == nil && !pn.IsEmpty() {
				return pn.User, false
			}
		}
	}
	return sender.User, true
}

func (inst *Instance) onReceipt(e *events.Receipt) {
	if e.IsFromMe || e.IsGroup {
		return
	}
	var status string
	switch e.Type {
	case types.ReceiptTypeDelivered:
		status = "DELIVERED"
	case types.ReceiptTypeRead, types.ReceiptTypePlayed:
		status = "READ"
	default:
		return
	}
	// Receipts are cosmetic for RentOS; never hold the event loop for them.
	go inst.mgr.hook.Deliver(ReceiptEvent{Type: "receipt", InstanceID: inst.id, IDs: e.MessageIDs, Status: status})
}

// describe reduces a message to a kind and the text RentOS shows in the inbox.
func describe(m *waE2E.Message) (string, string) {
	if m == nil {
		return "", ""
	}
	switch {
	case m.GetConversation() != "":
		return "text", m.GetConversation()
	case m.GetExtendedTextMessage() != nil:
		return "text", m.GetExtendedTextMessage().GetText()
	case m.GetImageMessage() != nil:
		return "image", m.GetImageMessage().GetCaption()
	case m.GetVideoMessage() != nil:
		return "video", m.GetVideoMessage().GetCaption()
	case m.GetDocumentMessage() != nil:
		d := m.GetDocumentMessage()
		return "document", firstNonEmpty(d.GetCaption(), d.GetFileName())
	case m.GetAudioMessage() != nil:
		if m.GetAudioMessage().GetPTT() {
			return "voice", ""
		}
		return "audio", ""
	case m.GetStickerMessage() != nil:
		return "sticker", ""
	case m.GetLocationMessage() != nil:
		l := m.GetLocationMessage()
		return "location", firstNonEmpty(l.GetName(), l.GetAddress(), fmt.Sprintf("%f,%f", l.GetDegreesLatitude(), l.GetDegreesLongitude()))
	case m.GetContactMessage() != nil:
		return "contact", m.GetContactMessage().GetDisplayName()
	case m.GetButtonsResponseMessage() != nil:
		return "text", m.GetButtonsResponseMessage().GetSelectedDisplayText()
	case m.GetListResponseMessage() != nil:
		return "text", m.GetListResponseMessage().GetTitle()
	case m.GetPollCreationMessage() != nil:
		return "poll", m.GetPollCreationMessage().GetName()
	}
	return "", ""
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// redact keeps logs free of full phone numbers (Smile PRD §13, logging hygiene).
func redact(phone string) string {
	if len(phone) <= 4 {
		return "****"
	}
	return "…" + phone[len(phone)-4:]
}

// recentInbound remembers where each recent inbound message came from, so a
// read receipt can be addressed to the right chat (which may be a LID) when
// RentOS only knows the message id.
type recentInbound struct {
	mu    sync.Mutex
	max   int
	order []types.MessageID
	byID  map[types.MessageID][2]types.JID
}

func newRecentInbound(max int) *recentInbound {
	return &recentInbound{max: max, byID: map[types.MessageID][2]types.JID{}}
}

func (r *recentInbound) put(id types.MessageID, chat, sender types.JID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.byID[id]; !ok {
		r.order = append(r.order, id)
	}
	r.byID[id] = [2]types.JID{chat, sender}
	for len(r.order) > r.max {
		delete(r.byID, r.order[0])
		r.order = r.order[1:]
	}
}

func (r *recentInbound) get(id types.MessageID) (chat, sender types.JID, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.byID[id]
	return v[0], v[1], ok
}
