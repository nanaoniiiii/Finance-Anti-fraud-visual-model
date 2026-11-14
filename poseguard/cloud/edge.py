"""Stdlib-only transport shared by Windows and MaixCAM.

The inference thread only counts and writes local evidence. Network I/O runs in
a separate thread; outbox files are removed only after server acceptance.
"""
from __future__ import annotations

import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

DEFAULT_RULES = dict(frame_threshold=100, escalation_threshold=300,
                     include_candidates=True, clear_grace_seconds=2.0,
                     heartbeat_seconds=30, retention_days=7)
RISKS = {"phone_to_ear", "multi_person", "lingering"}


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def atomic_json(path, value, private=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".new")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    if private and os.name != "nt":
        os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def append_record(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def valid_server(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}):
        raise ValueError("remote device services require HTTPS")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("server URL must not contain credentials/query/fragment")
    return url.rstrip("/")


def http_json(server, path, payload, token=None, timeout=12):
    request = urllib.request.Request(valid_server(server) + path,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "PoseGuard/1.2.0", **({"Authorization": "Bearer " + token} if token else {})}, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def enroll(server, code, platform, path):
    server = valid_server(server)
    result = http_json(server, "/api/enroll", {"code": code, "platform": platform})
    config = {"server_url": server, "device_id": result["device_id"],
              "device_token": result["device_token"], "platform": platform,
              "rules": result.get("rules", DEFAULT_RULES), "data_directory": str(Path(path).parent / "cloud-data")}
    atomic_json(path, config, private=True)
    return {"device_id": config["device_id"], "platform": platform, "config_path": str(path)}


class IncidentMonitor:
    def __init__(self, directory, rules=None, *, monotonic=time.monotonic,
                 wall_clock=utc_now, snapshot=None):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        (self.directory / "outbox").mkdir(exist_ok=True)
        self.rules = {**DEFAULT_RULES, **(rules or {})}
        self.monotonic = monotonic
        self.wall_clock = wall_clock
        self.snapshot_callback = snapshot
        self.active = {}
        self.session_id = uuid.uuid4().hex
        self.last_error = ""

    def _record(self, incident, action, **extra):
        append_record(self.directory / "incidents.jsonl", {
            "recorded_at": self.wall_clock(), "event_id": incident["event_id"],
            "session_id": self.session_id, "track_id": incident["track_id"],
            "risk_kind": incident["risk_kind"], "action": action,
            "observed_frames": incident["count"], "severity": incident["severity"],
            "model_state": incident["state"], **extra})

    def _snapshot(self, incident):
        if not self.snapshot_callback:
            return None
        folder = self.directory / "evidence" / incident["event_id"]
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / ("r%06d.jpg" % incident["revision"])
        try:
            result = self.snapshot_callback(incident["bbox"], str(path))
            if result is False or not path.is_file() or path.stat().st_size > 200000:
                raise ValueError("snapshot unavailable or exceeds 200KB")
            incident["snapshot_path"] = str(path)
            incident["snapshot_at"] = self.wall_clock()
            return {"data_base64": base64.b64encode(path.read_bytes()).decode("ascii"),
                    "captured_at": incident["snapshot_at"]}
        except Exception as error:
            self._record(incident, "snapshot_error", detail=str(error)[:200])
            return None

    def _queue(self, incident, update_type, termination_reason=""):
        incident["revision"] += 1
        picture = self._snapshot(incident) if update_type in {"created", "escalated"} else None
        payload = {"event_id": incident["event_id"], "revision": incident["revision"],
            "track_id": incident["track_id"], "session_id": self.session_id,
            "risk_kind": incident["risk_kind"], "model_state": incident["state"],
            "confirmed_seen": incident["confirmed_seen"], "observed_frames": incident["count"],
            "occurred_at": incident["occurred_at"], "updated_at": self.wall_clock(),
            "clock_synced": datetime.datetime.now().year >= 2024,
            "update_type": update_type, "severity": incident["severity"],
            "termination_reason": termination_reason,
            "summary": "累计特殊状态，需结合现场人工核查"}
        if picture:
            payload["snapshot"] = picture
        filename = incident["event_id"] + "-r%06d.json" % incident["revision"]
        atomic_json(self.directory / "outbox" / filename, payload)
        incident["reported"] = True
        self._record(incident, "queued_" + update_type)
        return payload

    @staticmethod
    def severity(incident):
        count, rules = incident["count"], incident["rules"]
        if count <= rules["frame_threshold"]:
            return 0
        if incident["confirmed_seen"] and count > rules["escalation_threshold"]:
            return 3
        if incident["confirmed_seen"] or count > rules["escalation_threshold"]:
            return 2
        return 1

    def update(self, observations, *, timestamp=None):
        timestamp = self.monotonic() if timestamp is None else timestamp
        updates = []
        seen = set()
        try:
            for item in observations:
                kind = item.get("risk_kind", item.get("risk"))
                state = item.get("state")
                if kind not in RISKS or state not in {"candidate", "alert"} or not item.get("observed", True):
                    continue
                key = (int(item["track_id"]), kind)
                if key in seen:
                    continue
                seen.add(key)
                incident = self.active.get(key)
                is_new = incident is None
                if incident is None:
                    incident = {"event_id": uuid.uuid4().hex, "track_id": key[0], "risk_kind": kind,
                        "state": state, "count": 0, "confirmed_seen": False, "severity": 0,
                        "revision": 0, "reported": False, "occurred_at": self.wall_clock(),
                        "last_positive": timestamp, "rules": dict(self.rules), "bbox": item.get("bbox")}
                    self.active[key] = incident
                previous_state = incident["state"]
                incident["last_positive"] = timestamp
                incident["state"] = state
                incident["bbox"] = item.get("bbox")
                if state == "alert":
                    incident["confirmed_seen"] = True
                if state == "alert" or incident["rules"]["include_candidates"]:
                    incident["count"] += 1
                if is_new:
                    self._record(incident, "special_state_started")
                    self._snapshot(incident)
                if previous_state != state:
                    self._record(incident, "model_state_changed", previous_state=previous_state)
                degree = self.severity(incident)
                if degree > incident["severity"]:
                    incident["severity"] = degree
                    updates.append(self._queue(incident, "escalated" if incident["reported"] else "created"))
                    if degree >= 3:
                        self._record(incident, "staff_intervention_requested", requested_by="device_policy")
                if is_new or incident["count"] % 30 == 0 or updates or previous_state != state:
                    atomic_json(self.directory / "state" / (incident["event_id"] + ".json"),
                                {k:v for k,v in incident.items() if k != "last_positive"})
            for key, incident in list(self.active.items()):
                if key not in seen and timestamp - incident["last_positive"] >= incident["rules"]["clear_grace_seconds"]:
                    self._record(incident, "special_state_cleared")
                    if incident["reported"]:
                        updates.append(self._queue(incident, "resolved"))
                    del self.active[key]
            self.last_error = ""
        except OSError as error:
            self.last_error = str(error)[:200]
        return updates

    def reset(self, reason="input_reset"):
        for incident in list(self.active.values()):
            try:
                self._record(incident, "special_state_interrupted", reason=reason)
                if incident["reported"]:
                    self._queue(incident, "interrupted", reason)
            except OSError as error:
                self.last_error = str(error)[:200]
        self.active.clear()


class CloudRelay:
    def __init__(self, config_path, *, health=None):
        self.config_path = Path(config_path)
        self.config = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.config["server_url"] = valid_server(self.config["server_url"])
        self.directory = Path(self.config["data_directory"])
        (self.directory / "outbox").mkdir(parents=True, exist_ok=True)
        self.health = health or (lambda: {})
        self.stop_event = threading.Event()
        self.last_error = ""
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self._run, name="poseguard-cloud", daemon=True)
        self.thread.start()
        return self

    def close(self):
        deadline = time.monotonic() + 4
        while self.thread and self.thread.is_alive() and time.monotonic() < deadline and any((self.directory / "outbox").glob("*.json")):
            time.sleep(0.05)
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=1)

    def _post(self, path, payload):
        return http_json(self.config["server_url"], path, payload, self.config["device_token"])

    def _run(self):
        heartbeat_due = 0.0
        retry_at = 0.0
        failures = 0
        while not self.stop_event.is_set():
            timestamp = time.monotonic()
            if timestamp < retry_at:
                self.stop_event.wait(min(1, retry_at-timestamp))
                continue
            try:
                if timestamp >= heartbeat_due:
                    pending = len(list((self.directory / "outbox").glob("*.json")))
                    response = self._post("/api/device/heartbeat", {**self.health(), "outbox_pending": pending,
                        "clock_synced": datetime.datetime.now().year >= 2024,
                        "firmware": "poseguard-1.2.0"})
                    if response.get("rules"):
                        self.config["rules"] = response["rules"]
                        atomic_json(self.directory / "policy.json", response["rules"])
                    for command in response.get("pending_commands", []):
                        receipt = self.directory / "commands" / (command["id"] + ".json")
                        if not receipt.exists():
                            atomic_json(receipt, command)
                            append_record(self.directory / "interventions.jsonl", {
                                "recorded_at": utc_now(), "action": command["kind"], "command_id": command["id"],
                                "cloud_incident_id": command.get("incident_id"), "details": json.loads(command["payload_json"])})
                        self._post("/api/device/commands/" + command["id"] + "/ack", {})
                    heartbeat_due = timestamp + max(10, self.config.get("rules", {}).get("heartbeat_seconds", 30))
                for path in sorted((self.directory / "outbox").glob("*.json"))[:12]:
                    try:
                        payload = json.loads(path.read_text(encoding="utf-8"))
                    except (ValueError, OSError):
                        quarantine = self.directory / "rejected"
                        quarantine.mkdir(exist_ok=True)
                        os.replace(path, quarantine / path.name)
                        continue
                    response = self._post("/api/device/events", payload)
                    if not response.get("accepted"):
                        raise RuntimeError("server did not accept incident")
                    append_record(self.directory / "delivery.jsonl", {"accepted_at": utc_now(),
                        "event_id": payload["event_id"], "revision": payload["revision"],
                        "cloud_incident_id": response.get("incident_id"), "duplicate": response.get("duplicate", False)})
                    path.unlink()
                failures = 0
                self.last_error = ""
            except Exception as error:
                failures += 1
                self.last_error = str(error)[:200]
                retry_at = timestamp + min(60, 2**min(failures, 6))
                try:
                    append_record(self.directory / "transport.jsonl", {"recorded_at": utc_now(),
                        "action": "retry_scheduled", "error": self.last_error, "attempt": failures})
                except OSError:
                    pass
            self.stop_event.wait(0.5)


def main():
    import argparse
    parser=argparse.ArgumentParser(description="PoseGuard device binding and relay")
    parser.add_argument("command",choices=["enroll","relay"])
    parser.add_argument("--server",default="https://poseguard.nanaoni.tech")
    parser.add_argument("--code")
    parser.add_argument("--platform",choices=["windows","maixcam"],default="windows")
    parser.add_argument("--config",required=True)
    args=parser.parse_args()
    if args.command=="enroll":
        if not args.code:
            parser.error("--code is required for enrollment")
        print(json.dumps(enroll(args.server,args.code,args.platform,args.config)))
    else:
        relay=CloudRelay(args.config).start()
        try:
            while True: time.sleep(1)
        except KeyboardInterrupt:
            relay.close()


if __name__=="__main__":
    main()
