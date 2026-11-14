// PoseGuard's network process: TLS, durable outbox, heartbeats and staff commands.
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

const version = "1.2.0"

type Config struct {
	Server    string `json:"server_url"`
	ID        string `json:"device_id"`
	Token     string `json:"device_token"`
	Platform  string `json:"platform"`
	Directory string `json:"data_directory"`
	HealthURL string `json:"health_url,omitempty"`
	Dial      string `json:"dial_address,omitempty"`
	Reverse   string `json:"reverse_listen,omitempty"`
	CAFile    string `json:"ca_file,omitempty"`
	ctx       context.Context
}
type apiError struct {
	Status  int
	Message string
}

func (e *apiError) Error() string { return fmt.Sprintf("HTTP %d: %s", e.Status, e.Message) }
func utc() string                 { return time.Now().UTC().Format(time.RFC3339Nano) }
func atomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(path+".new", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(path+".new", path); err != nil {
		return err
	}
	if d, e := os.Open(filepath.Dir(path)); e == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
func appendJSON(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err = f.Write(append(data, '\n')); err != nil {
		return err
	}
	return f.Sync()
}
func serverURL(raw string) (*url.URL, error) {
	u, e := url.Parse(raw)
	if e != nil {
		return nil, e
	}
	if u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Trim(u.Path, "/") != "" {
		return nil, errors.New("server must be an origin without credentials or path")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost")) {
		return nil, errors.New("remote servers require HTTPS")
	}
	return u, nil
}
func client(c Config) (*http.Client, error) {
	u, err := serverURL(c.Server)
	if err != nil {
		return nil, err
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: u.Hostname()}
	if c.CAFile != "" {
		pem, e := os.ReadFile(c.CAFile)
		if e != nil {
			return nil, e
		}
		roots, e := x509.SystemCertPool()
		if e != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(pem) {
			return nil, errors.New("CA file contains no certificates")
		}
		tlsConfig.RootCAs = roots
	}
	transport := &http.Transport{Proxy: http.ProxyFromEnvironment, TLSClientConfig: tlsConfig, ResponseHeaderTimeout: 12 * time.Second}
	if c.Reverse != "" {
		host, _, e := net.SplitHostPort(c.Reverse)
		if e != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
			return nil, errors.New("USB reverse listener must be a loopback IP and port")
		}
		listener, e := net.Listen("tcp", c.Reverse)
		if e != nil {
			return nil, e
		}
		connections := make(chan net.Conn)
		go func() {
			for {
				connection, e := listener.Accept()
				if e != nil {
					return
				}
				select {
				case connections <- connection:
				case <-time.After(20 * time.Second):
					_ = connection.Close()
				}
			}
		}()
		transport.Proxy = nil
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			select {
			case connection := <-connections:
				return connection, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
	}
	if c.Dial != "" {
		host, _, e := net.SplitHostPort(c.Dial)
		if e != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
			return nil, errors.New("USB tunnel dial address must be a loopback IP and port")
		}
		transport.Proxy = nil
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 12 * time.Second}).DialContext(ctx, network, c.Dial)
		}
	}
	return &http.Client{Transport: transport, Timeout: 18 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}, nil
}
func post(cl *http.Client, c Config, path string, payload []byte) (map[string]any, error) {
	ctx := c.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(c.Server, "/")+path, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	res, err := cl.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var body map[string]any
	_ = json.Unmarshal(data, &body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		message, _ := body["error"].(string)
		return nil, &apiError{res.StatusCode, message}
	}
	if body == nil {
		return nil, errors.New("server returned invalid JSON")
	}
	return body, nil
}
func marshal(v any) []byte { data, _ := json.Marshal(v); return data }
func readConfig(path string) (Config, error) {
	var c Config
	data, e := os.ReadFile(path)
	if e != nil {
		return c, e
	}
	if e = json.Unmarshal(data, &c); e != nil {
		return c, e
	}
	if c.ID == "" || !strings.HasPrefix(c.Token, "pgd_") {
		return c, errors.New("config is not enrolled")
	}
	if !filepath.IsAbs(c.Directory) {
		return c, errors.New("data_directory must be absolute")
	}
	return c, nil
}
func heartbeat(cl *http.Client, c Config) error {
	files, _ := filepath.Glob(filepath.Join(c.Directory, "outbox", "*.json"))
	health := map[string]any{"mode": "relay", "firmware": "poseguard-relay/" + version, "outbox_pending": len(files), "clock_synced": time.Now().Year() >= 2024, "capabilities": map[string]any{"local_evidence": true, "staff_commands": true}}
	if c.HealthURL != "" {
		u, e := url.Parse(c.HealthURL)
		if e != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") {
			return errors.New("health_url must point to localhost")
		}
		hc := &http.Client{Timeout: 2 * time.Second}
		if res, e := hc.Get(c.HealthURL); e == nil {
			var status map[string]any
			_ = json.NewDecoder(io.LimitReader(res.Body, 20000)).Decode(&status)
			_ = res.Body.Close()
			if state, ok := status["input_state"].(string); ok {
				health["mode"] = state
			}
			for _, k := range []string{"fps", "source", "last_error"} {
				if v, ok := status[k]; ok {
					health[k] = v
				}
			}
			if p, ok := status["tracks"]; ok {
				health["people"] = p
			}
		} else {
			health["mode"] = "inference_unavailable"
			health["last_error"] = "Local inference status is unavailable"
		}
	}
	result, err := post(cl, c, "/api/device/heartbeat", marshal(health))
	if err != nil {
		return err
	}
	if rules, ok := result["rules"].(map[string]any); ok {
		if err = atomic(filepath.Join(c.Directory, "policy.json"), marshal(rules)); err != nil {
			return err
		}
		candidate := 0
		if rules["include_candidates"] == true {
			candidate = 1
		}
		policy := fmt.Sprintf("threshold %.0f\nescalation %.0f\ninclude_candidates %d\ngrace_ms %.0f\n", rules["frame_threshold"], rules["escalation_threshold"], candidate, rules["clear_grace_seconds"].(float64)*1000)
		if err = atomic(filepath.Join(c.Directory, "policy.env"), []byte(policy)); err != nil {
			return err
		}
	}
	known := map[string]bool{}
	if data, e := os.ReadFile(filepath.Join(c.Directory, "command-ids.json")); e == nil {
		_ = json.Unmarshal(data, &known)
	}
	if commands, ok := result["pending_commands"].([]any); ok {
		for _, raw := range commands {
			cmd, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			id, _ := cmd["id"].(string)
			if id == "" {
				continue
			}
			if !known[id] {
				cmd["received_at"] = utc()
				if err = appendJSON(filepath.Join(c.Directory, "interventions.jsonl"), cmd); err != nil {
					return err
				}
				known[id] = true
				if err = atomic(filepath.Join(c.Directory, "command-ids.json"), marshal(known)); err != nil {
					return err
				}
			}
			if _, err = post(cl, c, "/api/device/commands/"+url.PathEscape(id)+"/ack", []byte("{}")); err != nil {
				return err
			}
		}
	}
	return atomic(filepath.Join(c.Directory, "relay-status.json"), marshal(map[string]any{"connected": true, "last_success": utc(), "pending": len(files), "device_id": c.ID, "version": version}))
}
func drain(cl *http.Client, c Config) (int, error) {
	files, _ := filepath.Glob(filepath.Join(c.Directory, "outbox", "*.json"))
	sort.Strings(files)
	sent := 0
	for _, file := range files {
		if sent >= 12 {
			break
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return sent, err
		}
		if len(data) > 420000 || !json.Valid(data) {
			err = errors.New("invalid local event payload")
		} else {
			var result map[string]any
			result, err = post(cl, c, "/api/device/events", data)
			if err == nil {
				var event map[string]any
				_ = json.Unmarshal(data, &event)
				if err = appendJSON(filepath.Join(c.Directory, "receipts.jsonl"), map[string]any{"accepted_at": utc(), "event_id": event["event_id"], "revision": event["revision"], "result": result}); err != nil {
					return sent, err
				}
				if err = os.Remove(file); err != nil {
					return sent, err
				}
				sent++
				continue
			}
		}
		var api *apiError
		permanent := errors.As(err, &api) && (api.Status == 400 || api.Status == 409 || api.Status == 413 || api.Status == 422)
		if permanent || !json.Valid(data) || len(data) > 420000 {
			folder := filepath.Join(c.Directory, "rejected")
			if e := os.MkdirAll(folder, 0700); e != nil {
				return sent, e
			}
			if e := appendJSON(filepath.Join(folder, "errors.jsonl"), map[string]any{"at": utc(), "file": filepath.Base(file), "error": err.Error()}); e != nil {
				return sent, e
			}
			if e := os.Rename(file, filepath.Join(folder, filepath.Base(file))); e != nil {
				return sent, e
			}
			log.Printf("event quarantined: %s", filepath.Base(file))
			continue
		}
		return sent, err
	}
	return sent, nil
}
func run(c Config) error {
	cl, err := client(c)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	c.ctx = ctx
	nextHeartbeat := time.Time{}
	delay := time.Second
	for {
		if ctx.Err() != nil {
			return nil
		}
		if time.Now().After(nextHeartbeat) {
			err = heartbeat(cl, c)
			if err == nil {
				nextHeartbeat = time.Now().Add(30 * time.Second)
			}
		}
		if err == nil {
			_, err = drain(cl, c)
		}
		if err != nil {
			log.Printf("cloud sync unavailable: %.240s; local outbox preserved", err.Error())
			_ = atomic(filepath.Join(c.Directory, "relay-status.json"), marshal(map[string]any{"connected": false, "error": fmt.Sprintf("%T", err), "checked_at": utc()}))
			delay *= 2
			if delay > 60*time.Second {
				delay = 60 * time.Second
			}
		} else {
			delay = time.Second
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delay):
		}
		err = nil
	}
}
func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println("PoseGuard relay " + version)
		return
	}
	mode := "run"
	args := os.Args[1:]
	if len(args) > 0 && (args[0] == "enroll" || args[0] == "run") {
		mode = args[0]
		args = args[1:]
	}
	flags := flag.NewFlagSet(mode, flag.ExitOnError)
	configPath := flags.String("config", "cloud.json", "private configuration file")
	server := flags.String("server", "https://poseguard.nanaoni.tech", "cloud origin")
	code := flags.String("code", "", "one-use enrollment code")
	platform := flags.String("platform", "rk3566", "device platform")
	dial := flags.String("dial-address", "", "optional USB TLS tunnel at loopback IP:port")
	reverse := flags.String("reverse-listen", "", "accept USB TLS transport via adb forward")
	direct := flags.Bool("direct", false, "use the board network without a USB tunnel")
	ca := flags.String("ca-file", "", "additional PEM trust roots")
	_ = flags.Parse(args)
	if mode == "enroll" {
		directory, _ := filepath.Abs(filepath.Join(filepath.Dir(*configPath), "cloud-data"))
		c := Config{Server: *server, Platform: *platform, Dial: *dial, Reverse: *reverse, CAFile: *ca, Directory: directory}
		if *platform == "rk3566" {
			c.HealthURL = "http://127.0.0.1:8081/status.json"
		}
		cl, e := client(c)
		if e == nil {
			var result map[string]any
			result, e = post(cl, c, "/api/enroll", marshal(map[string]any{"code": *code, "platform": *platform}))
			if e == nil {
				c.ID, _ = result["device_id"].(string)
				c.Token, _ = result["device_token"].(string)
				if c.ID == "" || c.Token == "" {
					e = errors.New("incomplete enrollment response")
				} else {
					e = atomic(*configPath, marshal(c))
					if e == nil {
						fmt.Println("Device enrolled; private config saved. Device ID: " + c.ID)
					}
				}
			}
		}
		if e != nil {
			log.Fatal(e)
		}
		return
	}
	c, e := readConfig(*configPath)
	if e != nil {
		log.Fatal(e)
	}
	if *dial != "" {
		c.Dial = *dial
	}
	if *reverse != "" {
		c.Reverse = *reverse
	}
	if *direct {
		c.Reverse = ""
		c.Dial = ""
	}
	if *ca != "" {
		c.CAFile = *ca
	}
	if e = run(c); e != nil {
		log.Fatal(e)
	}
}
