package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math/rand/v2"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// SendError carries the code RentOS branches on. ChannelWide means nothing
// will send on this number until someone acts (pair it, wait out a ban), as
// opposed to a problem with this one recipient.
type SendError struct {
	Status      int
	Code        string
	Message     string
	ChannelWide bool
}

func (e *SendError) Error() string { return e.Message }

// sendState spaces sends on one number and counts them per day.
type sendState struct {
	mu       sync.Mutex // held for the whole send, so one number sends one message at a time
	last     time.Time
	day      string
	count    int
	onWA     map[string]onWhatsApp
	countsMu sync.Mutex
}

type onWhatsApp struct {
	jid     types.JID
	in      bool
	checked time.Time
}

// capZone is the day boundary of the daily cap. Asia/Jakarta by default
// (WA_BRIDGE_TZ), so "today" for a branch is its own calendar day rather than
// one that flips over at 07:00 WIB.
var capZone = time.UTC

func today() string { return time.Now().In(capZone).Format("2006-01-02") }

// The daily cap counter lives in wa.daily_send_counts (PRD go-live §9.3), so
// a restart — or a crash loop — no longer hands the number a fresh allowance.
// One atomic upsert per send: the row lock serializes concurrent reservations
// for the same number. When the manager has no database (unit tests) the
// in-memory sendState counts instead.

func (inst *Instance) reserveSend(ctx context.Context, cap int) (bool, error) {
	if inst.mgr.db == nil {
		return inst.send.reserve(cap), nil
	}
	row := inst.mgr.db.QueryRowContext(ctx, `
		INSERT INTO wa.daily_send_counts (instance_id, day, count) VALUES ($1, $2, 1)
		ON CONFLICT (instance_id, day) DO UPDATE SET count = wa.daily_send_counts.count + 1
		WHERE $3 <= 0 OR wa.daily_send_counts.count < $3
		RETURNING count`, inst.id, today(), cap)
	var n int
	switch err := row.Scan(&n); {
	case errors.Is(err, sql.ErrNoRows):
		return false, nil
	case err != nil:
		return false, err
	}
	if cap > 0 && n > cap { // a fresh row with a cap below 1
		inst.releaseSend(ctx)
		return false, nil
	}
	return true, nil
}

func (inst *Instance) releaseSend(ctx context.Context) {
	if inst.mgr.db == nil {
		inst.send.release()
		return
	}
	// Detached from the request context: a cancelled send must still give its slot back.
	_, _ = inst.mgr.db.ExecContext(context.WithoutCancel(ctx),
		`UPDATE wa.daily_send_counts SET count = count - 1 WHERE instance_id = $1 AND day = $2 AND count > 0`, inst.id, today())
}

func (inst *Instance) sentToday(ctx context.Context) int {
	if inst.mgr.db == nil {
		return inst.send.countToday()
	}
	var n int
	if err := inst.mgr.db.QueryRowContext(ctx,
		`SELECT count FROM wa.daily_send_counts WHERE instance_id = $1 AND day = $2`, inst.id, today()).Scan(&n); err != nil {
		return 0
	}
	return n
}

func (s *sendState) countToday() int {
	s.countsMu.Lock()
	defer s.countsMu.Unlock()
	if s.day != today() {
		return 0
	}
	return s.count
}

func (s *sendState) reserve(cap int) bool {
	s.countsMu.Lock()
	defer s.countsMu.Unlock()
	if d := today(); s.day != d {
		s.day, s.count = d, 0
	}
	if cap > 0 && s.count >= cap {
		return false
	}
	s.count++
	return true
}

func (s *sendState) release() {
	s.countsMu.Lock()
	defer s.countsMu.Unlock()
	if s.count > 0 {
		s.count--
	}
}

// normalizePhone turns "+62 812-3456", "0812 3456" or "628123456" into
// WhatsApp's digits-only international form.
func normalizePhone(raw, defaultCC string) (string, error) {
	var b strings.Builder
	for _, r := range raw {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	digits := b.String()
	if strings.HasPrefix(digits, "0") {
		digits = defaultCC + strings.TrimLeft(digits, "0")
	}
	if len(digits) < 8 || len(digits) > 15 {
		return "", fmt.Errorf("%q is not a phone number WhatsApp can address", raw)
	}
	return digits, nil
}

// clientRef is the client captured under inst.mu, used after the lock is
// released so a slow send never blocks status reads.
type clientRef struct{ cli *whatsmeow.Client }

// connected returns the client if this instance can send right now.
func (inst *Instance) connected() (*clientRef, error) {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	if inst.client == nil || inst.client.Store.ID == nil {
		return nil, &SendError{Status: 409, Code: "not_paired", Message: ErrNotPaired.Error(), ChannelWide: true}
	}
	switch inst.state {
	case StateLoggedOut, StateReplaced, StateBanned:
		return nil, &SendError{Status: 409, Code: inst.state, Message: "WhatsApp number is " + strings.ReplaceAll(inst.state, "_", " ") + ": " + inst.detail, ChannelWide: true}
	}
	if !inst.client.IsConnected() || !inst.client.IsLoggedIn() {
		// Never queued: a reminder fired hours late is worse than one that
		// failed now and is visible as FAILED in RentOS (Smile PRD §11).
		return nil, &SendError{Status: 503, Code: "disconnected", Message: "The WhatsApp number is not connected right now (phone offline or reconnecting).", ChannelWide: true}
	}
	return &clientRef{inst.client}, nil
}

// SendText delivers one text message, paced against the previous send on this
// number. It blocks until WhatsApp's server acknowledged the message.
func (inst *Instance) SendText(ctx context.Context, to, text string) (string, error) {
	cfg := inst.mgr.cfg
	phone, err := normalizePhone(to, cfg.DefaultCountryCode)
	if err != nil {
		return "", &SendError{Status: 400, Code: "bad_recipient", Message: err.Error()}
	}
	if strings.TrimSpace(text) == "" {
		return "", &SendError{Status: 400, Code: "empty", Message: "Refusing to send an empty message."}
	}
	ref, err := inst.connected()
	if err != nil {
		return "", err
	}
	ok, err := inst.reserveSend(ctx, cfg.DailyCap)
	if err != nil {
		// Fail closed: a send we cannot count is a send that could break the cap.
		return "", &SendError{Status: 503, Code: "counter_unavailable", Message: "Could not reserve today's send slot: " + err.Error(), ChannelWide: true}
	}
	if !ok {
		return "", &SendError{Status: 429, Code: "daily_cap", Message: fmt.Sprintf("This number has sent its %d messages for today (WA_BRIDGE_DAILY_CAP).", cfg.DailyCap), ChannelWide: true}
	}
	sent := false
	defer func() {
		if !sent {
			inst.releaseSend(ctx)
		}
	}()

	jid, err := inst.resolve(ctx, ref, phone)
	if err != nil {
		return "", err
	}

	inst.send.mu.Lock()
	defer inst.send.mu.Unlock()
	// Pace: at least MinGap since the last send, plus jitter, with a short
	// "typing…" in front, so a batch reads like a person working a queue.
	wait := time.Until(inst.send.last.Add(cfg.MinGap)) + time.Duration(rand.IntN(1500))*time.Millisecond
	if err := sleep(ctx, wait); err != nil {
		return "", err
	}
	_ = ref.cli.SendChatPresence(ctx, jid, types.ChatPresenceComposing, types.ChatPresenceMediaText)
	if err := sleep(ctx, time.Duration(800+rand.IntN(1200))*time.Millisecond); err != nil {
		return "", err
	}
	resp, err := ref.cli.SendMessage(ctx, jid, &waE2E.Message{Conversation: proto.String(text)})
	_ = ref.cli.SendChatPresence(context.Background(), jid, types.ChatPresencePaused, types.ChatPresenceMediaText)
	inst.send.last = time.Now()
	if err != nil {
		return "", &SendError{Status: 502, Code: "send_failed", Message: "WhatsApp did not accept the message: " + err.Error()}
	}
	sent = true
	return resp.ID, nil
}

// resolve checks the number is on WhatsApp (cached for a day) and returns the
// canonical JID. A clear "not on WhatsApp" beats a message that silently never
// arrives, and it is a per-recipient failure, not a channel one.
func (inst *Instance) resolve(ctx context.Context, ref *clientRef, phone string) (types.JID, error) {
	inst.send.countsMu.Lock()
	if inst.send.onWA == nil {
		inst.send.onWA = map[string]onWhatsApp{}
	}
	cached, ok := inst.send.onWA[phone]
	inst.send.countsMu.Unlock()
	if ok && time.Since(cached.checked) < 24*time.Hour {
		if !cached.in {
			return types.JID{}, notOnWhatsApp(phone)
		}
		return cached.jid, nil
	}

	results, err := ref.cli.IsOnWhatsApp(ctx, []string{"+" + phone})
	if err != nil || len(results) == 0 {
		// Lookup trouble is not proof of absence; try the plain JID.
		return types.NewJID(phone, types.DefaultUserServer), nil
	}
	entry := onWhatsApp{jid: results[0].JID, in: results[0].IsIn, checked: time.Now()}
	if entry.jid.IsEmpty() {
		entry.jid = types.NewJID(phone, types.DefaultUserServer)
	}
	inst.send.countsMu.Lock()
	inst.send.onWA[phone] = entry
	inst.send.countsMu.Unlock()
	if !entry.in {
		return types.JID{}, notOnWhatsApp(phone)
	}
	return entry.jid, nil
}

func notOnWhatsApp(phone string) error {
	return &SendError{Status: 422, Code: "not_on_whatsapp", Message: fmt.Sprintf("+%s is not registered on WhatsApp.", phone)}
}

// MarkRead sends blue ticks for inbound messages this process has seen.
func (inst *Instance) MarkRead(ctx context.Context, ids []string) error {
	ref, err := inst.connected()
	if err != nil {
		return err
	}
	type key struct{ chat, sender types.JID }
	grouped := map[key][]types.MessageID{}
	for _, id := range ids {
		if chat, sender, ok := inst.recent.get(id); ok {
			k := key{chat, sender}
			grouped[k] = append(grouped[k], id)
		}
	}
	var errs []error
	for k, group := range grouped {
		if err := ref.cli.MarkRead(ctx, group, time.Now(), k.chat, k.sender); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
