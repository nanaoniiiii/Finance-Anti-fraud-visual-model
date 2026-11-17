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
from poseguard.cloud.orientation import CameraOrientation


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
    if isinstance(source,str) and hasattr(cv2,'CAP_PROP_ORIENTATION_AUTO'):
        # FFmpeg builds differ in their default for video display matrices.
        # Apply file metadata before installation-direction inference/resizing.
        capture.set(cv2.CAP_PROP_ORIENTATION_AUTO,1)
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
    parser.add_argument("--local-only", action="store_true", help="record candidates and screenshots locally without external uploads")
    parser.add_argument("--trace-file", default=None, help="append actual per-frame tracks and risk observations as JSONL")
    parser.add_argument("--stop-file", default=None, help="stop cleanly when this local control file exists")
    parser.add_argument("--camera-rotation", choices=['auto','0','90','180','270'], default='auto')
    parser.add_argument("--camera-mirror", action='store_true')
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
    preview = None
    orientation = CameraOrientation(getattr(args,'camera_rotation','auto'),getattr(args,'camera_mirror',False))
    previous_direction = None
    display_shape = None
    if getattr(args, "cloud_config", None) or getattr(args,"local_only",False):
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

        from poseguard.cloud.preview import PreviewPublisher
        def encode_preview(image, profile):
            original_height, original_width = image.shape[:2]
            ratio = min(1.0,profile['long_side']/max(original_width,original_height))
            if ratio < 1:
                image = cv2.resize(image,(max(16,int(original_width*ratio)),max(16,int(original_height*ratio))),interpolation=cv2.INTER_AREA)
            ok, jpeg = cv2.imencode('.jpg',image,[cv2.IMWRITE_JPEG_QUALITY,profile['quality']])
            if not ok: raise RuntimeError('Preview JPEG encoding failed')
            return jpeg.tobytes(), image.shape[1], image.shape[0], original_width, original_height
        if getattr(args,"cloud_config",None) and not getattr(args,"local_only",False):
            cloud_relay = CloudRelay(args.cloud_config, health=lambda: dict(cloud_health))
            preview = PreviewPublisher(cloud_relay.config,encode_preview,lambda f:f.copy()).start()
            cloud_health['capabilities'] = dict(preview=True,pose_overlay=True,camera_orientation=True)
            cloud_relay.start()
            cloud_monitor = IncidentMonitor(cloud_relay.directory, cloud_relay.config.get("rules"), snapshot=capture_person)
        else:
            cloud_monitor=IncidentMonitor(output_dir/'local-records',snapshot=capture_person)

    try:
        capture = open_capture(source, config["camera"])
        video_rate = capture.get(cv2.CAP_PROP_FPS) if isinstance(source, str) else 0.0
        video_epoch = time.monotonic()
        while True:
            if getattr(args,"stop_file",None) and Path(args.stop_file).exists():
                break
            if paused and config["display"]["enabled"]:
                key = cv2.waitKey(30) & 0xFF
                try:
                    window_visible = cv2.getWindowProperty(title, cv2.WND_PROP_VISIBLE) >= 1
                except cv2.error:
                    window_visible = False
                if not window_visible:
                    break
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
            camera_settings = preview.camera() if preview else dict(rotation=orientation.mode,mirror=orientation.mirror,version=0)
            orientation.configure(camera_settings['rotation'],camera_settings['mirror'])
            def rotate_input(image, degrees, mirror):
                if degrees:
                    image = cv2.rotate(image,{90:cv2.ROTATE_90_CLOCKWISE,180:cv2.ROTATE_180,270:cv2.ROTATE_90_COUNTERCLOCKWISE}[degrees])
                return cv2.flip(image,1) if mirror else image
            frame, observations, _ = orientation.process(frame,time.monotonic(),pose_backend.infer,rotate_input)
            direction = (orientation.rotation,orientation.mirror)
            if previous_direction is not None and previous_direction != direction:
                tracker = PersonTrackManager(**config['tracking'])
                engine = RiskRuleEngine(**config['risk'])
                previous_alerts.clear()
                if cloud_monitor: cloud_monitor.reset('camera_orientation_changed')
            previous_direction = direction
            if preview: preview.apply(camera_settings,*direction)
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
                if cloud_relay is not None:
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
            if getattr(args,"trace_file",None):
                from poseguard.cloud.edge import append_record
                append_record(args.trace_file,{"frame":processed_frames,"source_timestamp":timestamp-video_epoch if video_rate else timestamp,"orientation":orientation.rotation,"inference_ms":inference_ms,"people":sum(not track.predicted for track in tracks),"tracks":[{"id":track.track_id,"predicted":track.predicted,"confirmed":track.confirmed,"bbox":list(track.bbox)}for track in tracks],"risks":[{"id":decision.track_id,"kind":decision.kind.value,"state":decision.state.value,"duration_s":decision.duration_seconds}for decision in decisions]})

            now = time.perf_counter()
            instantaneous_fps = 1.0 / max(now - previous_frame_time, 1e-6)
            fps = instantaneous_fps if fps == 0 else fps * 0.85 + instantaneous_fps * 0.15
            previous_frame_time = now
            if preview:
                preview.submit(frame,tracks,decisions,fps,processed_frames,camera=camera_settings,
                    rotation=orientation.rotation,mirror=orientation.mirror,source_type='video' if isinstance(source,str) else 'camera')

            if config["display"]["enabled"]:
                canvas = renderer.render(
                    frame,
                    tracks,
                    decisions,
                    {"fps": fps, "inference_ms": inference_ms},
                    recent_events=tuple(text for _, text in recent_events),
                )
                title="PoseGuard - Suspicious Behavior Assistance"
                if display_shape!=canvas.shape[:2]:
                    width,height=1280,800
                    if sys.platform.startswith('win'):
                        import ctypes
                        width=ctypes.windll.user32.GetSystemMetrics(0)
                        height=ctypes.windll.user32.GetSystemMetrics(1)
                    ratio=min(1,(width-100)/canvas.shape[1],(height-120)/canvas.shape[0])
                    cw,ch=max(160,int(canvas.shape[1]*ratio)),max(160,int(canvas.shape[0]*ratio))
                    cv2.namedWindow(title,cv2.WINDOW_NORMAL|cv2.WINDOW_KEEPRATIO)
                    cv2.resizeWindow(title,cw,ch)
                    cv2.moveWindow(title,max(0,(width-cw)//2),max(0,(height-ch-50)//2))
                    display_shape=canvas.shape[:2]
                cv2.imshow(title, canvas)
                key = cv2.waitKey(1) & 0xFF
                if is_exit_key(key):
                    break
                try:
                    window_visible = cv2.getWindowProperty(title, cv2.WND_PROP_VISIBLE) >= 1
                except cv2.error:
                    window_visible = False
                if not window_visible:
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
        if preview is not None:
            preview.close()
        if cloud_monitor is not None:
            cloud_monitor.reset("application_stopped")
        if cloud_relay is not None:
            cloud_relay.close()
        if capture is not None:
            capture.release()
        if logger is not None:
            logger.close()
        if config["display"]["enabled"]:
            cv2.destroyAllWindows()


def main() -> int:
    return run(build_parser().parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
