"""MaixCAM Pro camera-to-pose-to-alert runtime."""

import argparse
import time

try:
    from .config import CONFIG
    from .event_store import EventStore
    from .pose_adapter import adapt_objects
    from .risk_core import RiskEngine
    from .screen import ScreenRenderer
    from .track_core import TrackManager
except ImportError:  # Direct execution from /root/poseguard_maix.
    from config import CONFIG
    from event_store import EventStore
    from pose_adapter import adapt_objects
    from risk_core import RiskEngine
    from screen import ScreenRenderer
    from track_core import TrackManager


class PosePipeline:
    def __init__(self, settings, track_manager, risk_engine):
        self.settings = settings
        self.track_manager = track_manager
        self.risk_engine = risk_engine

    def reset(self):
        self.track_manager.reset()
        self.risk_engine.reset()

    def update(self, objects, timestamp, frame_size):
        observations = adapt_objects(objects, frame_size, self.settings)
        tracks = self.track_manager.update(observations, timestamp)
        decisions = self.risk_engine.evaluate(tracks, frame_size, timestamp)
        return tracks, decisions


def build_pipeline(overrides=None, test_timers=False):
    settings = dict(CONFIG)
    if overrides:
        settings.update(overrides)
    if test_timers:
        settings.update(
            {
                "phone_pose_seconds": 0.3,
                "multi_person_seconds": 0.3,
                "lingering_seconds": 2.0,
            }
        )

    track_manager = TrackManager(
        minimum_confidence=settings["pose_confidence"],
        max_missing_seconds=settings["maximum_missing_seconds"],
        smoothing_alpha=settings["smoothing_alpha"],
        maximum_match_cost=settings["maximum_match_cost"],
        min_confirmed_hits=settings["minimum_confirmed_hits"],
        max_tracks=settings["maximum_tracks"],
    )
    risk_engine = RiskEngine(
        region=settings["region"],
        phone_seconds=settings["phone_pose_seconds"],
        multi_seconds=settings["multi_person_seconds"],
        lingering_seconds=settings["lingering_seconds"],
        release_seconds=settings["alert_release_seconds"],
        wrist_ear_ratio=settings["wrist_ear_ratio"],
        forearm_min_ratio=settings["forearm_min_ratio"],
        torso_vertical_ratio=settings["torso_vertical_ratio"],
        standing_span_ratio=settings["standing_span_ratio"],
        lingering_speed_ratio=settings["lingering_max_speed_ratio"],
        lingering_pose_motion_ratio=settings[
            "lingering_max_pose_motion_ratio"
        ],
    )
    return PosePipeline(settings, track_manager, risk_engine)


def process_detections(
    objects,
    *,
    timestamp,
    frame_size,
    pipeline=None,
    config=None,
):
    active_pipeline = pipeline or build_pipeline(config)
    return active_pipeline.update(objects, timestamp, frame_size)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="PoseGuard MaixCAM runtime")
    parser.add_argument(
        "--max-frames",
        type=int,
        default=0,
        help="stop after N frames; zero runs continuously",
    )
    parser.add_argument(
        "--no-display",
        action="store_true",
        help="run inference and events without opening the LCD",
    )
    parser.add_argument(
        "--test-timers",
        action="store_true",
        help="shorten temporal thresholds for an on-device demo",
    )
    parser.add_argument("--cloud-config", default=None, help="bound cloud configuration JSON")
    return parser.parse_args(argv)


def run(*, max_frames=0, no_display=False, test_timers=False, cloud_config=None):
    from maix import app, camera, display, image, nn

    settings = dict(CONFIG)
    pipeline = build_pipeline(settings, test_timers=test_timers)
    renderer = ScreenRenderer(color_factory=image.Color.from_rgb)
    event_store = EventStore(settings["event_path"])

    detector = None
    cam = None
    disp = None
    frame_count = 0
    consecutive_failures = 0
    loop_started = time.monotonic()
    latest_metrics = {"fps": 0.0, "inference_ms": 0.0}
    cloud_relay = None
    cloud_monitor = None
    cloud_frame = None
    cloud_health = {"mode": "starting", "fps": 0.0, "people": 0, "source": "MaixCAM camera"}
    if cloud_config:
        try:
            from poseguard.cloud.edge import CloudRelay, IncidentMonitor
        except ImportError:
            from poseguard_cloud import CloudRelay, IncidentMonitor

        def capture_person(box, destination):
            if cloud_frame is None or not box:
                return False
            left, top, right, bottom = [int(value) for value in box]
            left, top = max(0, left), max(0, top)
            right, bottom = min(width, right), min(height, bottom)
            if right <= left or bottom <= top:
                return False
            cloud_frame.crop(left, top, right-left, bottom-top).save(destination)
            return True

        cloud_relay = CloudRelay(cloud_config, health=lambda: dict(cloud_health)).start()
        cloud_monitor = IncidentMonitor(cloud_relay.directory, cloud_relay.config.get("rules"), snapshot=capture_person)

    try:
        detector = nn.YOLO11(model=settings["model_path"], dual_buff=True)
        width = int(detector.input_width())
        height = int(detector.input_height())
        if (width, height) != (320, 224):
            raise RuntimeError(
                "expected 320x224 model, got {}x{}".format(width, height)
            )
        print(
            "MODEL path={} input={}x{} format={}".format(
                settings["model_path"],
                width,
                height,
                detector.input_format(),
            ),
            flush=True,
        )

        cam = camera.Camera(width, height, detector.input_format())
        if settings["display_enabled"] and not no_display:
            try:
                disp = display.Display()
            except Exception as exc:
                print("DISPLAY disabled: {}".format(exc), flush=True)
                disp = None

        while not app.need_exit() and (
            max_frames <= 0 or frame_count < max_frames
        ):
            try:
                frame = cam.read()
                inference_started = time.monotonic()
                objects = detector.detect(
                    frame,
                    conf_th=settings["pose_confidence"],
                    iou_th=settings["pose_iou"],
                    keypoint_th=settings["keypoint_threshold"],
                )
                inference_ms = (
                    time.monotonic() - inference_started
                ) * 1000.0
                consecutive_failures = 0
            except Exception as exc:
                consecutive_failures += 1
                print(
                    "FRAME_ERROR count={} error={}".format(
                        consecutive_failures,
                        exc,
                    ),
                    flush=True,
                )
                if consecutive_failures >= 5:
                    raise RuntimeError("five consecutive frame failures") from exc
                time.sleep(0.05)
                continue

            timestamp = time.monotonic()
            tracks, decisions = pipeline.update(
                objects,
                timestamp,
                (width, height),
            )
            frame_count += 1
            elapsed = max(timestamp - loop_started, 1e-6)
            latest_metrics = {
                "fps": frame_count / elapsed,
                "inference_ms": inference_ms,
            }
            people = len(
                [track for track in tracks if not track.get("predicted", False)]
            )
            alerts = len(
                [item for item in decisions if item["state"] == "alert"]
            )
            event_store.publish(
                decisions,
                timestamp=time.time(),
                people=people,
                metrics=latest_metrics,
            )
            if cloud_monitor is not None:
                cloud_frame = frame
                observed_ids = {track["track_id"] for track in tracks if not track.get("predicted", False)}
                cloud_monitor.rules = {**cloud_monitor.rules, **cloud_relay.config.get("rules", {})}
                cloud_monitor.update([{"track_id": item["track_id"], "risk_kind": item["risk"],
                    "state": item["state"], "bbox": next((track["bbox"] for track in tracks if track["track_id"] == item["track_id"]), None),
                    "observed": item["track_id"] in observed_ids} for item in decisions], timestamp=timestamp)
                cloud_health.update(mode="running", fps=latest_metrics["fps"], people=people, last_error=cloud_monitor.last_error)

            if disp is not None:
                renderer.render(frame, tracks, decisions, latest_metrics)
                disp.show(frame)

            if frame_count % 30 == 0:
                print(
                    "METRIC frames={} fps={:.2f} infer_ms={:.2f} people={} alerts={}".format(
                        frame_count,
                        latest_metrics["fps"],
                        latest_metrics["inference_ms"],
                        people,
                        alerts,
                    ),
                    flush=True,
                )
    finally:
        if cloud_monitor is not None:
            cloud_monitor.reset("application_stopped")
        if cloud_relay is not None:
            cloud_relay.close()
        _close_resource(disp, "display")
        _close_resource(cam, "camera")
        detector = None

    print(
        "FINISHED frames={} fps={:.2f} infer_ms={:.2f}".format(
            frame_count,
            latest_metrics["fps"],
            latest_metrics["inference_ms"],
        ),
        flush=True,
    )
    return 0


def _close_resource(resource, name):
    if resource is None or not hasattr(resource, "close"):
        return
    try:
        resource.close()
    except Exception as exc:
        print("CLOSE_WARNING resource={} error={}".format(name, exc), flush=True)


def main(argv=None):
    args = parse_args(argv)
    return run(
        max_frames=max(args.max_frames, 0),
        no_display=args.no_display,
        test_timers=args.test_timers,
        cloud_config=args.cloud_config,
    )


if __name__ == "__main__":
    raise SystemExit(main())
