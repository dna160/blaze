package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// API is the HTTP surface RentOS calls. Every route but /healthz needs
// `Authorization: Bearer $WA_BRIDGE_TOKEN`; the bridge is meant to sit on a
// private network next to the API and worker, never on the public internet.
type API struct {
	cfg Config
	mgr *Manager
}

func NewAPI(cfg Config, mgr *Manager) *API { return &API{cfg: cfg, mgr: mgr} }

var instanceIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func (a *API) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /instances/{id}", a.auth(a.status))
	mux.HandleFunc("POST /instances/{id}/pair", a.auth(a.pair))
	mux.HandleFunc("POST /instances/{id}/logout", a.auth(a.logout))
	mux.HandleFunc("POST /instances/{id}/send", a.auth(a.send))
	mux.HandleFunc("POST /instances/{id}/read", a.auth(a.read))
	return mux
}

func (a *API) auth(next func(http.ResponseWriter, *http.Request, *Instance)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(token), []byte(a.cfg.Token)) != 1 {
			writeError(w, &SendError{Status: http.StatusUnauthorized, Code: "unauthorized", Message: "Bad or missing bridge token."})
			return
		}
		id := r.PathValue("id")
		if !instanceIDPattern.MatchString(id) {
			writeError(w, &SendError{Status: http.StatusBadRequest, Code: "bad_instance", Message: "Instance ids are 1-64 characters of [A-Za-z0-9_-]."})
			return
		}
		next(w, r, a.mgr.get(id))
	}
}

func (a *API) status(w http.ResponseWriter, _ *http.Request, inst *Instance) {
	writeJSON(w, http.StatusOK, inst.Status())
}

func (a *API) pair(w http.ResponseWriter, r *http.Request, inst *Instance) {
	var body struct {
		Phone string `json:"phone"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	phone, err := normalizePhone(body.Phone, a.cfg.DefaultCountryCode)
	if err != nil {
		writeError(w, &SendError{Status: http.StatusBadRequest, Code: "bad_phone", Message: err.Error()})
		return
	}
	code, expires, err := inst.Pair(phone)
	if errors.Is(err, ErrAlreadyPaired) {
		writeError(w, &SendError{Status: http.StatusConflict, Code: "already_paired", Message: err.Error()})
		return
	}
	if err != nil {
		writeError(w, &SendError{Status: http.StatusBadGateway, Code: "pair_failed", Message: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"code": code, "expiresAt": expires})
}

func (a *API) logout(w http.ResponseWriter, r *http.Request, inst *Instance) {
	if err := inst.Logout(r.Context()); err != nil {
		writeError(w, &SendError{Status: http.StatusBadGateway, Code: "logout_failed", Message: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, inst.Status())
}

func (a *API) send(w http.ResponseWriter, r *http.Request, inst *Instance) {
	var body struct {
		To   string `json:"to"`
		Text string `json:"text"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	started := time.Now()
	id, err := inst.SendText(r.Context(), body.To, body.Text)
	if err != nil {
		writeError(w, err)
		return
	}
	log.Printf("instance %s: sent %s to %s in %s", shortID(inst.id), id, redact(body.To), time.Since(started).Round(time.Millisecond))
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

func (a *API) read(w http.ResponseWriter, r *http.Request, inst *Instance) {
	var body struct {
		IDs []string `json:"ids"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if err := inst.MarkRead(r.Context(), body.IDs); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func readJSON(w http.ResponseWriter, r *http.Request, into any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(into); err != nil {
		writeError(w, &SendError{Status: http.StatusBadRequest, Code: "bad_json", Message: "Malformed JSON body: " + err.Error()})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	var se *SendError
	if !errors.As(err, &se) {
		se = &SendError{Status: http.StatusInternalServerError, Code: "internal", Message: err.Error()}
	}
	writeJSON(w, se.Status, map[string]any{"error": se.Message, "code": se.Code, "channelWide": se.ChannelWide})
}
