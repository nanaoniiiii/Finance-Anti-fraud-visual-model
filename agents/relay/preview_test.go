package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestPreviewRetainsDeviceIdentityAndControlConnection(t *testing.T) {
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/preview/status" {
			w.Write([]byte(`{"codecs":["jpeg"],"pose":true,"camera":true,"camera_applied_version":0}`))
			return
		}
		if r.URL.Path == "/preview/control" {
			if r.Method != "POST" || r.Header.Get("Content-Type") != "application/json" {
				t.Error("invalid local control")
			}
			w.Write([]byte(`{}`))
			return
		}
		w.WriteHeader(204)
	}))
	defer local.Close()
	got := make(chan bool, 1)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer pgd_protocol_test" {
			t.Error("device identity not forwarded")
		}
		ws, e := websocket.Accept(w, r, nil)
		if e != nil {
			return
		}
		defer ws.CloseNow()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		ws.Write(ctx, websocket.MessageText, []byte(`{"type":"control","active":false,"fps":3,"long_side":432,"quality":45,"bitrate":180000,"lease_ms":8000,"codec":"jpeg","camera":{"rotation":"auto","mirror":false,"version":0}}`))
		for {
			_, bytes, e := ws.Read(ctx)
			if e != nil {
				return
			}
			if string(bytes) != "" {
				got <- true
				return
			}
		}
	}))
	defer remote.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- previewConnection(ctx, Config{Server: remote.URL, Token: "pgd_protocol_test", HealthURL: local.URL + "/status.json"}, local.URL)
	}()
	select {
	case <-got:
	case <-time.After(4 * time.Second):
		t.Fatal("preview connection did not exchange control after handshake")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("preview did not stop on cancellation")
	}
}
