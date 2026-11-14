package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRemoteTLSRequired(t *testing.T) {
	for _, bad := range []string{"http://example.com", "https://u:p@example.com", "https://example.com/api", "https://example.com/?token=x"} {
		if _, e := serverURL(bad); e == nil {
			t.Fatal("accepted invalid server", bad)
		}
	}
}
func TestOutboxSurvivesServerFailure(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if r.Header.Get("Authorization") != "Bearer pgd_test" {
			t.Error("device authentication missing")
		}
		if attempts == 1 {
			w.WriteHeader(503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"accepted":true,"incident_id":"cloud-id"}`))
	}))
	defer server.Close()
	c := Config{Server: server.URL, Token: "pgd_test", Directory: t.TempDir()}
	cl, e := client(c)
	if e != nil {
		t.Fatal(e)
	}
	file := filepath.Join(c.Directory, "outbox", "event-r000001.json")
	if e = atomic(file, []byte(`{"event_id":"same-event","revision":1,"observed_frames":101}`)); e != nil {
		t.Fatal(e)
	}
	if _, e = drain(cl, c); e == nil {
		t.Fatal("failure should be returned")
	}
	if _, e = os.Stat(file); e != nil {
		t.Fatal("failed event lost")
	}
	if n, e := drain(cl, c); e != nil || n != 1 {
		t.Fatal(n, e)
	}
	if _, e = os.Stat(file); !os.IsNotExist(e) {
		t.Fatal("accepted event remains in outbox")
	}
	data, e := os.ReadFile(filepath.Join(c.Directory, "receipts.jsonl"))
	if e != nil || !strings.Contains(string(data), `"event_id":"same-event"`) {
		t.Fatal("durable receipt missing", e)
	}
}
func TestCommandsRecordedOnceBeforeAck(t *testing.T) {
	acks := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/ack") {
			acks++
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"rules": map[string]any{"frame_threshold": 100, "escalation_threshold": 300, "clear_grace_seconds": 2, "include_candidates": true}, "pending_commands": []map[string]any{{"id": "cmd1", "kind": "staff_intervention_requested"}}})
	}))
	defer server.Close()
	c := Config{Server: server.URL, Token: "pgd_test", Directory: t.TempDir()}
	cl, e := client(c)
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 2; i++ {
		if e = heartbeat(cl, c); e != nil {
			t.Fatal(e)
		}
	}
	data, e := os.ReadFile(filepath.Join(c.Directory, "interventions.jsonl"))
	if e != nil || strings.Count(string(data), "cmd1") != 1 || acks != 2 {
		t.Fatal("command idempotence failed", acks, e)
	}
	data, e = os.ReadFile(filepath.Join(c.Directory, "policy.env"))
	if e != nil || !strings.Contains(string(data), "include_candidates 1") {
		t.Fatal("candidate policy missing", e)
	}
}
