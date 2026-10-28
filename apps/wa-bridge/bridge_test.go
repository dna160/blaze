package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

func TestNormalizePhone(t *testing.T) {
	cases := map[string]string{
		"+62 812-3456-7890": "6281234567890",
		"0812 3456 7890":    "6281234567890",
		"6281234567890":     "6281234567890",
		"+1 (415) 555-0100": "14155550100",
	}
	for in, want := range cases {
		got, err := normalizePhone(in, "62")
		if err != nil || got != want {
			t.Errorf("normalizePhone(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "12345", "+1234567890123456"} {
		if _, err := normalizePhone(bad, "62"); err == nil {
			t.Errorf("normalizePhone(%q) accepted a non-number", bad)
		}
	}
}

func TestDescribe(t *testing.T) {
	cases := []struct {
		msg        *waE2E.Message
		kind, text string
	}{
		{&waE2E.Message{Conversation: proto.String("halo")}, "text", "halo"},
		{&waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("balas")}}, "text", "balas"},
		{&waE2E.Message{ImageMessage: &waE2E.ImageMessage{Caption: proto.String("bukti")}}, "image", "bukti"},
		{&waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{FileName: proto.String("ktp.pdf")}}, "document", "ktp.pdf"},
		{&waE2E.Message{AudioMessage: &waE2E.AudioMessage{PTT: proto.Bool(true)}}, "voice", ""},
		// Reactions and protocol messages are not inbox content.
		{&waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{Text: proto.String("👍")}}, "", ""},
		{nil, "", ""},
	}
	for i, c := range cases {
		kind, text := describe(c.msg)
		if kind != c.kind || text != c.text {
			t.Errorf("case %d: describe = (%q, %q); want (%q, %q)", i, kind, text, c.kind, c.text)
		}
	}
}

func TestSignMatchesRentOS(t *testing.T) {
	// apps/api verifies with createHmac("sha256", token).update(rawBody).digest("hex").
	body := []byte(`{"type":"message"}`)
	mac := hmac.New(sha256.New, []byte("secret"))
	mac.Write(body)
	if got, want := sign([]byte("secret"), body), "sha256="+hex.EncodeToString(mac.Sum(nil)); got != want {
		t.Fatalf("sign = %s; want %s", got, want)
	}
}

func TestRecentInboundEvicts(t *testing.T) {
	r := newRecentInbound(2)
	jid := types.NewJID("62811", types.DefaultUserServer)
	r.put("a", jid, jid)
	r.put("b", jid, jid)
	r.put("c", jid, jid)
	if _, _, ok := r.get("a"); ok {
		t.Error("oldest id should have been evicted")
	}
	if _, _, ok := r.get("c"); !ok {
		t.Error("newest id should be kept")
	}
}

func TestDailyCap(t *testing.T) {
	var s sendState
	if !s.reserve(2) || !s.reserve(2) {
		t.Fatal("first two sends should fit a cap of 2")
	}
	if s.reserve(2) {
		t.Fatal("third send should be refused")
	}
	s.release()
	if !s.reserve(2) {
		t.Fatal("a released slot should be reusable")
	}
}

func TestPostgresDSN(t *testing.T) {
	got, err := postgresDSN("postgresql://u:p@db:5432/rentos?schema=public&sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	if want := "postgresql://u:p@db:5432/rentos?search_path=wa&sslmode=disable"; got != want {
		t.Fatalf("postgresDSN = %s; want %s", got, want)
	}
}
