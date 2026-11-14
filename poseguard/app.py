"""Windows-first real-time risk pose application."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2

from poseguard.backends.yolo_phone import YoloPhoneBackend
from poseguard.backends.yolo_pose import YoloPoseBackend
from poseguard.config import apply_cli_overrides, load_config
from poseguard.io.event_log import EventLogger
from poseguard.risk.geometry import candidate_phone_sides
from poseguard.risk.risk_engine import RiskRuleEngine
from poseguard.tracking.observation_filter import PoseObservationFilter
from poseguard.tracking.person_tracks import PersonTrackManager
from poseguard.types import RiskDecision, RiskState
from poseguard.ui.overlay import OverlayRenderer, is_exit_key


class ResilientPhoneBackend:
    """Disable an optional phone backend after its first runtime failure."""

    def __init__(self, backend) -> None:
        self._backend = backend
        self.available = True

    def find(self, frame, regions):
        if not self.available:
            return ()
        try:
            return self._backend.find(frame, regions)
        except Exception as exc:
            self.available = False
            print(
                f"Optional phone detection disabled: {exc}",
                file=sys.stderr,
            )
            return ()


def update_alert_transitions(
    decisions,
    previous_alerts: set[tuple[int, str]],
    predicted_track_ids: set[int],
) -> tuple[tuple[RiskDecision, ...], set[tuple[int, str]]]:
    alerts = tuple(
        decision
        for decision in decisions
        if decision.state is RiskState.ALERT
    )
    active_keys = {
        (decision.track_id, decision.kind.value)
        for decision in alerts
    }
    new_events = tuple(
        decision
        for decision in alerts
        if (decision.track_id, decision.kind.value) not in previous_alerts
    )
    predicted_keys = {
        key for key in previous_alerts if key[0] in predicted_track_ids
    }
    return new_events, active_keys | predicted_keys


def update_recent_events(
    previous: tuple[tuple[tuple[int, str], str], ...],
    new_events,
    *,
    limit: int = 3,
) -> tuple[tuple[tuple[int, str], str], ...]:
    recent = list(previous)
    for decision in new_events:
        key = (decision.track_id, decision.kind.value)
        recent = [item for item in recent if item[0] != key]
        recent.append((key, f"ID {decision.track_id}: {decision.reason}"))
    return tuple(recent[-limit:])


def parse_source(value: str):
    return int(value) if value.isdecimal() else value


def open_capture(source, camera_config):
    if isinstance(source, int) and sys.platform.startswith("win"):
        capture = cv2.VideoCapture(source, cv2.CAP_DSHOW)
        if not capture.isOpened():
            capture.release()
            capture = cv2.VideoCapture(source)
    else:
        capture = cv2.VideoCapture(source)
    if not capture.isOpened():
        capture.release()
        raise RuntimeError(f"Cannot open video source: {source}")
    if isinstance(source, int):
        capture.set(cv2.CAP_PROP_BUFFERSIZE, int(camera_config["buffer_size"]))
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, int(camera_config["width"]))
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, int(camera_config["height"]))
        capture.set(cv2.CAP_PROP_FPS, int(camera_config["fps"]))
    return capture


def resize_for_processing(frame, max_width: int):
    if max_width <= 0 or frame.shape[1] <= max_width:
        return frame
    scale = max_width / frame.shape[1]
    return cv2.resize(
        frame,
        (max_width, int(frame.shape[0] * scale)),
        interpolation=cv2.INTER_AREA,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Local human risk pose monitor")
    parser.add_argument("--source", default=None, help="camera index or video path")
    parser.add_argument("--config", default="configs/windows.json")
    parser.add_argument("--pose-model", default=None)
    parser.add_argument("--phone-model", default=None)
    parser.add_argument("--disable-phone", action="store_true")
    parser.add_argument("--no-display", action="store_true")
    parser.add_argument("--output-dir", default=None)
    parser.add_argument("--max-frames", type=int, default=None)
    parser.add_argument("--cloud-config", default=None, help="bound device configuration; enables local evidence and cloud relay")
    return parser


def run(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    source = parse_source(args.source) if args.source is not None else config["source"]
    config = apply_cli_overrides(
        config,
        source=source,
        pose_model=args.pose_model,
        phone_model=args.phone_model,
        disable_phone=args.disable_phone,
        no_display=args.no_display,
        output_dir=args.output_dir,
    )

    pose_backend = YoloPoseBackend(
        config["models"]["pose_path"],
        confidence=config["models"]["pose_confidence"],
    )
    phone_backend = ResilientPhoneBackend(
        YoloPhoneBackend(
            config["models"]["phone_path"],
            enabled=config["features"]["phone_detection"],
            confidence=config["models"]["phone_confidence"],
            phone_class=config["models"]["phone_class"],
        )
    )
    observation_filter = PoseObservationFilter(**config["quality"])
    tracker = PersonTrackManager(**config["tracking"])
    engine = RiskRuleEngine(**config["risk"])
    renderer = OverlayRenderer()

    output_dir = Path(config["output"]["directory"])
    event_path = output_dir / config["output"]["event_filename"]
    logger = EventLogger(event_path) if config["features"]["event_logging"] else None
    capture = None
    previous_alerts: set[tuple[int, str]] = set()
    recent_events: tuple[str, ...] = ()
    previous_frame_time = time.perf_counter()
    fps = 0.0
    paused = False
    processed_frames = 0
    cloud_relay = None
    cloud_monitor = None
    cloud_health = {"mode": "starting", "fps": 0.0, "people": 0, "source": str(source)}
    cloud_frame = None
    if getattr(args, "cloud_config", None):
        from poseguard.cloud.edge import CloudRelay, IncidentMonitor

        def capture_person(box, destination):
            if cloud_frame is None or box is None:
                return False
            height, width = cloud_frame.shape[:2]
            left, top, right, bottom = [int(value) for value in box]
            left, top = max(0, left), max(0, top)
            right, bottom = min(width, right), min(height, bottom)
            if right <= left or bottom <= top:
                return False
            crop = cloud_frame[top:bottom, left:right]
            factor = min(1.0, 320 / max(crop.shape[:2]))
            if factor < 1:
                crop = cv2.resize(crop, (max(1, int(crop.shape[1]*factor)), max(1, int(crop.shape[0]*factor))), interpolation=cv2.INTER_AREA)
            return cv2.imwrite(destination, crop, [cv2.IMWRITE_JPEG_QUALITY, 75])

        cloud_relay = CloudRelay(args.cloud_config, health=lambda: dict(cloud_health)).start()
        cloud_monitor = IncidentMonitor(cloud_relay.directory, cloud_relay.config.get("rules"), snapshot=capture_person)

    try:
        capture = open_capture(source, config["camera"])
        video_rate = capture.get(cv2.CAP_PROP_FPS) if isinstance(source, str) else 0.0
        video_epoch = time.monotonic()
        while True:
            if paused and config["display"]["enabled"]:
                key = cv2.waitKey(30) & 0xFF
                if is_exit_key(key):
                    break
                if key in (ord("p"), ord("P")):
                    paused = False
                continue

            ok, frame = capture.read()
            if not ok:
                if isinstance(source, int):
                    print("Camera frame read failed; stopping cleanly.", file=sys.stderr)
                break
            frame = resize_for_processing(frame, int(config["display"]["max_width"]))
            timestamp = (video_epoch + processed_frames / video_rate
                         if video_rate and video_rate > 0 else time.monotonic())

            inference_start = time.perf_counter()
            observations = pose_backend.infer(frame)
            observations = observation_filter.filter(
                observations,
                (frame.shape[1], frame.shape[0]),
            )
            tracks = tracker.update(
                observations,
                timestamp,
                (frame.shape[1], frame.shape[0]),
            )
            candidate_regions = [
                track.bbox
                for track in tracks
                if not track.predicted
                and candidate_phone_sides(
                    track, config["risk"]["wrist_ear_ratio"]
                )
            ]
            phones = phone_backend.find(frame, candidate_regions)
            inference_ms = (time.perf_counter() - inference_start) * 1000.0

            decisions = engine.evaluate(
                tracks,
                phones,
                (frame.shape[1], frame.shape[0]),
                timestamp,
            )
            processed_frames += 1
            if cloud_monitor is not None:
                cloud_frame = frame
                cloud_monitor.rules = {**cloud_monitor.rules, **cloud_relay.config.get("rules", {})}
                observed_ids = {track.track_id for track in tracks if track.confirmed and not track.predicted}
                cloud_monitor.update([{"track_id": d.track_id, "risk_kind": d.kind.value,
                    "state": d.state.value, "bbox": d.bbox, "observed": d.track_id in observed_ids}
                    for d in decisions], timestamp=timestamp)
                cloud_health.update(mode="running", people=len(observed_ids), fps=fps, last_error=cloud_monitor.last_error)
            new_events, previous_alerts = update_alert_transitions(
                decisions,
                previous_alerts,
                {track.track_id for track in tracks if track.predicted},
            )
            if logger is not None:
                for decision in new_events:
                    logger.write(decision, timestamp=time.time())
            recent_events = update_recent_events(recent_events, new_events)

            now = time.perf_counter()
            instantaneous_fps = 1.0 / max(now - previous_frame_time, 1e-6)
            fps = instantaneous_fps if fps == 0 else fps * 0.85 + instantaneous_fps * 0.15
            previous_frame_time = now

            if config["display"]["enabled"]:
                canvas = renderer.render(
                    frame,
                    tracks,
                    decisions,
                    {"fps": fps, "inference_ms": inference_ms},
                    recent_events=tuple(text for _, text in recent_events),
                )
                cv2.imshow("PoseGuard - Suspicious Behavior Assistance", canvas)
                key = cv2.waitKey(1) & 0xFF
                if is_exit_key(key):
                    break
                if key in (ord("p"), ord("P")):
                    paused = True
            if args.max_frames is not None and processed_frames >= args.max_frames:
                break
        return 0
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    finally:
        if cloud_monitor is not None:
            cloud_monitor.reset("application_stopped")
        if cloud_relay is not None:
            cloud_relay.close()
        if capture is not None:
            capture.release()
        if logger is not None:
            logger.close()
        cv2.destroyAllWindows()


def main() -> int:
    return run(build_parser().parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
