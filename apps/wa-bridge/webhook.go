package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// Webhook delivers events to RentOS, signed with the shared token:
// `X-Bridge-Signature: sha256=<hex hmac of the exact body>`.
//
// Ack after commit, as in Smile: an event counts as handled only once RentOS
// answered 2xx, so a message is never acknowledged to WhatsApp while it exists
// nowhere but this process's memory. A false return makes whatsmeow withhold
// the ack and WhatsApp redelivers it after the next reconnect.
type Webhook struct {
	url    string
	secret []byte
	client *http.Client
}

func NewWebhook(url, secret string) *Webhook {
	return &Webhook{url: url, secret: []byte(secret), client: &http.Client{Timeout: 10 * time.Second}}
}

func sign(secret, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// Deliver tries three times with a short backoff. It runs on whatsmeow's event
// goroutine, so it must give up in seconds rather than stall every later event.
func (w *Webhook) Deliver(event any) bool {
	if w.url == "" {
		return true
	}
	body, err := json.Marshal(event)
	if err != nil {
		log.Printf("webhook: marshal: %v", err)
		return true // unrecoverable; redelivery would fail the same way
	}
	backoff := []time.Duration{0, time.Second, 3 * time.Second}
	for attempt, wait := range backoff {
		time.Sleep(wait)
		if err := w.post(body); err != nil {
			log.Printf("webhook: attempt %d: %v", attempt+1, err)
			continue
		}
		return true
	}
	return false
}

func (w *Webhook) post(body []byte) error {
	req, err := http.NewRequest(http.MethodPost, w.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Bridge-Signature", sign(w.secret, body))
	resp, err := w.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("RentOS answered %d: %s", resp.StatusCode, snippet)
	}
	return nil
}

// The three event shapes RentOS receives (apps/api wa-bridge webhook).

type MessageEvent struct {
	Type       string `json:"type"` // "message"
	InstanceID string `json:"instanceId"`
	ID         string `json:"id"`
	// Phone number digits, no +. When WhatsApp only gave a LID and no mapping
	// is known yet, this is the LID's digits and FromLID is true.
	From      string    `json:"from"`
	FromLID   bool      `json:"fromLid,omitempty"`
	PushName  string    `json:"pushName,omitempty"`
	Timestamp time.Time `json:"timestamp"`
	Kind      string    `json:"kind"`
	Text      string    `json:"text"`
}

type ReceiptEvent struct {
	Type       string   `json:"type"` // "receipt"
	InstanceID string   `json:"instanceId"`
	IDs        []string `json:"ids"`
	Status     string   `json:"status"` // DELIVERED | READ
}

type ConnectionEvent struct {
	Type       string `json:"type"` // "connection"
	InstanceID string `json:"instanceId"`
	State      string `json:"state"`
	Detail     string `json:"detail,omitempty"`
}
