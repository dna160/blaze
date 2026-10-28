// Command wa-bridge holds RentOS's WhatsApp linked-device sessions.
//
// This is Project Smile's WhatsApp layer, cut down to what RentOS needs: one
// whatsmeow linked device per organization number, paired with the 8-character
// code typed into WhatsApp → Linked devices → Link with phone number. No Meta
// app, no Business verification, no template approval — the number sends the
// same free text a person would type, and inbound messages and receipts are
// POSTed back to the RentOS API.
//
// It owns the session and nothing else. Which message goes to whom, and when,
// stays in RentOS (apps/api, apps/worker); this process only pairs, stays
// connected, sends, and forwards events. See README.md.
package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"
)

type Config struct {
	Port        string
	Token       string
	DatabaseURL string
	WebhookURL  string
	// Pacing between two sends on one number. Bulk sends are what get a
	// linked device banned; RentOS's batch jobs (invoice issue, dunning) fan
	// out to many customers at once, so the bridge spaces them, not the caller.
	MinGap   time.Duration
	DailyCap int
	// Prepended to a national number written with a leading 0 (Indonesia first).
	DefaultCountryCode string
	LogLevel           string
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
		log.Printf("ignoring %s=%q: not an integer", key, v)
	}
	return fallback
}

func loadConfig() (Config, error) {
	cfg := Config{
		Port:               env("PORT", "4200"),
		Token:              os.Getenv("WA_BRIDGE_TOKEN"),
		DatabaseURL:        env("WA_BRIDGE_DATABASE_URL", os.Getenv("DATABASE_URL")),
		WebhookURL:         os.Getenv("WA_BRIDGE_WEBHOOK_URL"),
		MinGap:             time.Duration(envInt("WA_BRIDGE_MIN_GAP_MS", 3000)) * time.Millisecond,
		DailyCap:           envInt("WA_BRIDGE_DAILY_CAP", 1000),
		DefaultCountryCode: env("WA_BRIDGE_DEFAULT_COUNTRY_CODE", "62"),
		LogLevel:           env("WA_BRIDGE_LOG_LEVEL", "WARN"),
	}
	if len(cfg.Token) < 32 {
		return cfg, errors.New("WA_BRIDGE_TOKEN must be set to at least 32 characters (openssl rand -hex 32)")
	}
	if cfg.DatabaseURL == "" {
		return cfg, errors.New("WA_BRIDGE_DATABASE_URL (or DATABASE_URL) must be set")
	}
	if cfg.WebhookURL == "" {
		log.Printf("WA_BRIDGE_WEBHOOK_URL is unset: inbound messages and receipts will be acknowledged and dropped")
	}
	return cfg, nil
}

// postgresDSN keeps the whatsmeow tables (Signal keys, sessions) in their own
// `wa` schema, out of Prisma's way, and drops Prisma's `?schema=` parameter,
// which lib/pq would otherwise send to the server as an unknown setting.
func postgresDSN(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Del("schema")
	q.Set("search_path", "wa")
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func openStore(ctx context.Context, cfg Config) (*sql.DB, *sqlstore.Container, error) {
	dsn, err := postgresDSN(cfg.DatabaseURL)
	if err != nil {
		return nil, nil, err
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, nil, err
	}
	if _, err := db.ExecContext(ctx, `CREATE SCHEMA IF NOT EXISTS wa`); err != nil {
		return nil, nil, err
	}
	// instance id (the RentOS organization id) → the device it paired.
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS wa.rentos_instances (
		id         text PRIMARY KEY,
		jid        text,
		updated_at timestamptz NOT NULL DEFAULT now()
	)`); err != nil {
		return nil, nil, err
	}
	container := sqlstore.NewWithDB(db, "postgres", waLog.Stdout("store", cfg.LogLevel, false))
	if err := container.Upgrade(ctx); err != nil {
		return nil, nil, err
	}
	return db, container, nil
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db, container, err := openStore(ctx, cfg)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	mgr := NewManager(cfg, db, container, NewWebhook(cfg.WebhookURL, cfg.Token))
	if err := mgr.Restore(ctx); err != nil {
		log.Fatalf("restore sessions: %v", err)
	}

	srv := &http.Server{Addr: ":" + cfg.Port, Handler: NewAPI(cfg, mgr).Routes(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		log.Printf("wa-bridge listening on :%s", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
	mgr.DisconnectAll()
}
