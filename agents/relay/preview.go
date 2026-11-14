package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const maxPreviewFrame = 600 * 1024

type cameraControl struct {
	Rotation string `json:"rotation"`
	Mirror   bool   `json:"mirror"`
	Version  uint64 `json:"version"`
}
type previewControl struct {
	Type     string        `json:"type"`
	Active   bool          `json:"active"`
	LeaseMS  int           `json:"lease_ms"`
	FPS      int           `json:"fps"`
	LongSide int           `json:"long_side"`
	Quality  int           `json:"quality"`
	Bitrate  int           `json:"bitrate"`
	Codec    string        `json:"codec"`
	Camera   cameraControl `json:"camera"`
}
type localPreviewStatus struct {
	Active  bool     `json:"active"`
	Applied uint64   `json:"camera_applied_version"`
	Codecs  []string `json:"codecs"`
	Pose    bool     `json:"pose"`
	Camera  bool     `json:"camera"`
}
type previewLease struct {
	mu      sync.Mutex
	control previewControl
	expires time.Time
}

func previewOrigin(c Config) (string, error) {
	raw := c.HealthURL
	if c.PreviewURL != "" {
		raw = c.PreviewURL
	}
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "http" || u.User != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") {
		return "", errors.New("preview source must be HTTP localhost")
	}
	return u.Scheme + "://" + u.Host, nil
}
func getPreviewStatus(ctx context.Context, origin string) (localPreviewStatus, error) {
	var status localPreviewStatus
	req, _ := http.NewRequestWithContext(ctx, "GET", origin+"/preview/status", nil)
	res, e := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if e != nil {
		return status, e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return status, fmt.Errorf("local preview status HTTP %d", res.StatusCode)
	}
	e = json.NewDecoder(io.LimitReader(res.Body, 16000)).Decode(&status)
	return status, e
}
func applyPreview(ctx context.Context, origin string, c previewControl) error {
	if c.Camera.Rotation != "auto" && c.Camera.Rotation != "0" && c.Camera.Rotation != "90" && c.Camera.Rotation != "180" && c.Camera.Rotation != "270" {
		return errors.New("invalid camera direction")
	}
	if c.FPS < 1 || c.FPS > 15 || c.LongSide < 240 || c.LongSide > 1280 || c.Quality < 25 || c.Quality > 85 || c.LeaseMS < 0 || c.LeaseMS > 10000 || (c.Codec != "jpeg" && c.Codec != "h264") {
		return errors.New("invalid preview profile")
	}
	q := url.Values{"active": {"0"}, "fps": {strconv.Itoa(c.FPS)}, "long_side": {strconv.Itoa(c.LongSide)}, "quality": {strconv.Itoa(c.Quality)},
		"bitrate": {strconv.Itoa(c.Bitrate)}, "lease_ms": {strconv.Itoa(c.LeaseMS)}, "codec": {c.Codec}, "rotation": {c.Camera.Rotation},
		"mirror": {"0"}, "version": {strconv.FormatUint(c.Camera.Version, 10)}}
	if c.Active {
		q.Set("active", "1")
	}
	if c.Camera.Mirror {
		q.Set("mirror", "1")
	}
	req, _ := http.NewRequestWithContext(ctx, "POST", origin+"/preview/control?"+q.Encode(), strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	res, e := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 16000))
	if res.StatusCode != 200 {
		return fmt.Errorf("local preview control HTTP %d", res.StatusCode)
	}
	return nil
}
func previewMeta(packet []byte) (map[string]any, error) {
	if len(packet) < 12 || len(packet) > maxPreviewFrame || string(packet[:4]) != "PGV1" {
		return nil, errors.New("invalid local preview packet")
	}
	n := int(binary.BigEndian.Uint32(packet[4:8]))
	if n < 2 || n > 24*1024 || 8+n >= len(packet) {
		return nil, errors.New("invalid local preview metadata")
	}
	var meta map[string]any
	if e := json.Unmarshal(packet[8:8+n], &meta); e != nil {
		return nil, e
	}
	return meta, nil
}
func sendPreviewJSON(ctx context.Context, ws *websocket.Conn, value any) error {
	deadline, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return ws.Write(deadline, websocket.MessageText, marshal(value))
}
func previewFrames(ctx context.Context, ws *websocket.Conn, origin string, lease *previewLease) {
	ticker := time.NewTicker(80 * time.Millisecond)
	defer ticker.Stop()
	var lastSequence uint64
	var lastEpoch string
	var reportedApplied uint64 = ^uint64(0)
	var caps string
	var inactiveSent bool
	lastStatus := time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		lease.mu.Lock()
		command, expires := lease.control, lease.expires
		lease.mu.Unlock()
		active := command.Active && time.Now().Before(expires)
		if !active && !inactiveSent && command.FPS > 0 {
			command.Active = false
			_ = applyPreview(ctx, origin, command)
			inactiveSent = true
		}
		if active {
			inactiveSent = false
		}
		if time.Since(lastStatus) > time.Second {
			lastStatus = time.Now()
			if status, e := getPreviewStatus(ctx, origin); e == nil {
				next := string(marshal(status.Codecs))
				if next != caps {
					caps = next
					_ = sendPreviewJSON(ctx, ws, map[string]any{"type": "hello", "codecs": status.Codecs, "pose": status.Pose, "camera": status.Camera})
				}
				if reportedApplied != status.Applied {
					reportedApplied = status.Applied
					_ = sendPreviewJSON(ctx, ws, map[string]any{"type": "applied", "version": status.Applied})
				}
			}
		}
		if !active {
			continue
		}
		q := url.Values{"after": {strconv.FormatUint(lastSequence, 10)}, "epoch": {lastEpoch}}
		req, _ := http.NewRequestWithContext(ctx, "GET", origin+"/preview/frame?"+q.Encode(), nil)
		response, e := (&http.Client{Timeout: 1500 * time.Millisecond}).Do(req)
		if e != nil {
			continue
		}
		packet, e := io.ReadAll(io.LimitReader(response.Body, maxPreviewFrame+1))
		_ = response.Body.Close()
		if e != nil || response.StatusCode != 200 {
			continue
		}
		meta, e := previewMeta(packet)
		if e != nil {
			continue
		}
		sequence, ok := meta["sequence"].(float64)
		epoch, okEpoch := meta["source_epoch"].(string)
		if !ok || !okEpoch || sequence < 1 {
			continue
		}
		if uint64(sequence) == lastSequence && epoch == lastEpoch {
			continue
		}
		deadline, cancel := context.WithTimeout(ctx, 2*time.Second)
		e = ws.Write(deadline, websocket.MessageBinary, packet)
		cancel()
		if e != nil {
			_ = ws.CloseNow()
			return
		}
		lastSequence, lastEpoch = uint64(sequence), epoch
	}
}
func runPreview(ctx context.Context, c Config) {
	origin, e := previewOrigin(c)
	if e != nil {
		return
	}
	delay := time.Second
	for ctx.Err() == nil {
		if _, e = getPreviewStatus(ctx, origin); e == nil {
			e = previewConnection(ctx, c, origin)
		}
		if ctx.Err() != nil {
			return
		}
		if e != nil {
      log.Printf("preview channel reconnecting (%T): %.180s; detection remains local", e, e.Error())
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		if delay < 15*time.Second {
			delay *= 2
		}
	}
}
func previewConnection(parent context.Context, c Config, origin string) error {
	cl, e := client(c)
	if e != nil {
		return e
	}
	u, _ := serverURL(c.Server)
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = "/api/device/preview/connect"
	dial, cancelDial := context.WithTimeout(parent, 18*time.Second)
	ws, _, e := websocket.Dial(dial, u.String(), &websocket.DialOptions{HTTPClient: cl, HTTPHeader: http.Header{"Authorization": {"Bearer " + c.Token}}})
	cancelDial()
	if e != nil {
		return e
	}
	defer ws.CloseNow()
	ws.SetReadLimit(8192)
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	lease := &previewLease{}
	go previewFrames(ctx, ws, origin, lease)
	go func() {
		tick := time.NewTicker(25 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				ping, end := context.WithTimeout(ctx, 8*time.Second)
				e := ws.Ping(ping)
				end()
				if e != nil {
					_ = ws.CloseNow()
					return
				}
			}
		}
	}()
	defer func() {
		lease.mu.Lock()
		stop := lease.control
		lease.mu.Unlock()
		if stop.FPS > 0 {
			stop.Active = false
			cleanup, end := context.WithTimeout(context.Background(), 2*time.Second)
			defer end()
			_ = applyPreview(cleanup, origin, stop)
		}
	}()
	for {
		typeOfMessage, data, e := ws.Read(ctx)
		if e != nil {
			return e
		}
		if typeOfMessage != websocket.MessageText {
			return errors.New("unexpected preview control")
		}
		var command previewControl
		if json.Unmarshal(data, &command) != nil || command.Type != "control" {
			continue
		}
		if e = applyPreview(ctx, origin, command); e != nil {
			_ = sendPreviewJSON(ctx, ws, map[string]any{"type": "status", "state": "source_unavailable", "message": "设备画面组件暂时不可用"})
			continue
		}
		lease.mu.Lock()
		lease.control = command
		lease.expires = time.Now().Add(time.Duration(command.LeaseMS) * time.Millisecond)
		lease.mu.Unlock()
	}
}
