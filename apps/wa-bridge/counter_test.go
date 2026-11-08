package main

import (
	"context"
	"database/sql"
	"os"
	"testing"
)

// TestPersistedDailyCap runs against a real Postgres (WA_BRIDGE_TEST_DATABASE_URL)
// and proves the cap survives a "restart": a second Manager on the same
// database sees the count the first one left.
func TestPersistedDailyCap(t *testing.T) {
	url := os.Getenv("WA_BRIDGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("WA_BRIDGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	dsn, err := postgresDSN(url)
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, q := range []string{
		`CREATE SCHEMA IF NOT EXISTS wa`,
		`CREATE TABLE IF NOT EXISTS wa.daily_send_counts (instance_id text NOT NULL, day date NOT NULL, count integer NOT NULL DEFAULT 0, PRIMARY KEY (instance_id, day))`,
		`DELETE FROM wa.daily_send_counts WHERE instance_id = 'cap-test'`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}

	first := &Instance{id: "cap-test", mgr: &Manager{db: db}}
	for i := 0; i < 2; i++ {
		if ok, err := first.reserveSend(ctx, 2); err != nil || !ok {
			t.Fatalf("send %d should fit a cap of 2 (ok=%v err=%v)", i+1, ok, err)
		}
	}
	restarted := &Instance{id: "cap-test", mgr: &Manager{db: db}}
	if got := restarted.sentToday(ctx); got != 2 {
		t.Fatalf("after restart sentToday = %d; want 2", got)
	}
	if ok, _ := restarted.reserveSend(ctx, 2); ok {
		t.Fatal("the cap must still hold after a restart")
	}
	restarted.releaseSend(ctx)
	if ok, _ := restarted.reserveSend(ctx, 2); !ok {
		t.Fatal("a released slot should be reusable")
	}
}
