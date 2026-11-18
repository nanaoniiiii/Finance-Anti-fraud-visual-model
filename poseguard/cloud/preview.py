"""On-demand outbound WSS; one latest frame, no persistent video or LAN port."""
import json
import socket
import struct
import threading
import time
import uuid
from pathlib import Path

try:
    from .edge import atomic_json
except ImportError:
    from poseguard_cloud import atomic_json


class PreviewPublisher:
    def __init__(self, config, encode, copy_frame, connect=None, *, network_revision=None):
        self.config, self.encode, self.copy_frame = config, encode, copy_frame
        self.connect=connect
        self.network_revision = network_revision
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = None
        self.pending = None
        self.lease = self.next_frame = 0
        self.profile = dict(fps=3, long_side=432, quality=45)
        self.camera_path = Path(config['data_directory']) / 'camera.json'
        try:
            self.settings = json.loads(self.camera_path.read_text(encoding='utf-8'))
        except (ValueError, OSError):
            self.settings = dict(rotation='auto', mirror=False, version=0)
        self.applied = -1
        self.rotation = 0
        self.mirror = False
        self.epoch = uuid.uuid4().hex
        self.last_error = ''
        self.failure_hook = None

    def start(self):
        import websocket  # Optional feature; install websocket-client first.
        self.thread = threading.Thread(target=self._run, name='poseguard-preview', daemon=True)
        self.thread.start()
        return self

    def close(self):
        self.stop_event.set()
        with self.lock:
            self.lease = 0
            self.pending = None
        if self.thread:
            self.thread.join(timeout=3)

    def camera(self):
        with self.lock:
            return dict(self.settings)

    def apply(self, camera, rotation, mirror):
        with self.lock:
            if (self.rotation, self.mirror) != (rotation, mirror):
                self.epoch = uuid.uuid4().hex
                self.pending = None
            self.applied, self.rotation, self.mirror = camera['version'], rotation, mirror

    def submit(self, frame, tracks, decisions, fps, sequence, *, camera, rotation, mirror, source_type='camera'):
        now = time.monotonic()
        with self.lock:
            if now >= self.lease or now < self.next_frame:
                return
            profile = dict(self.profile)
            self.next_frame = now + 1/profile['fps']
            epoch = self.epoch
        # Copy while still on the inference thread, before any screen overlays.
        image = self.copy_frame(frame)
        meta = dict(sequence=sequence, source_epoch=epoch, codec='jpeg', keyframe=True,
                    captured_ms=int(time.time()*1000), inference_fps=max(0, float(fps)),
                    detector_ready=True, source_type=source_type, orientation=rotation,
                    mirrored=mirror, camera_applied_version=camera['version'],is_test=bool(self.config.get('is_test',False)),
                    keypoint_confidence_kind=self.config.get('keypoint_confidence_kind','model'))
        with self.lock:
            if now < self.lease:
                self.pending = (image, tracks, decisions, meta, profile)

    @staticmethod
    def packet(payload, width, height, tracks, decisions, meta):
        def get(item, field, default=None):
            return getattr(item, field, default) if not isinstance(item, dict) else item.get(field, default)
        people = []
        for track in tracks[:8]:
            keypoints = []
            for p in get(track, 'keypoints', ()):
                if p is None:
                    keypoints.append(None)
                elif hasattr(p, 'x'):
                    keypoints.append([p.x/width, p.y/height, p.confidence])
                else:
                    keypoints.append([p[0]/width, p[1]/height, p[2] if len(p)>2 else 1.0])
            if len(keypoints) != 17:
                continue
            box = get(track, 'bbox')
            people.append(dict(id=int(get(track,'track_id')), bbox=[box[0]/width, box[1]/height, box[2]/width, box[3]/height],
                               keypoints=keypoints, confirmed=bool(get(track,'confirmed',True)), predicted=bool(get(track,'predicted',False))))
        risks = []
        fresh={p['id']for p in people if p['confirmed']and not p['predicted']}
        for decision in decisions[:24]:
            kind = get(decision, 'kind', get(decision,'risk'))
            state = get(decision, 'state')
            kind, state = getattr(kind,'value',kind), getattr(state,'value',state)
            if kind in ('phone_to_ear','multi_person','lingering') and state in ('candidate','alert') and int(get(decision,'track_id'))in fresh:
                risks.append(dict(id=int(get(decision,'track_id')),kind=kind,state=state))
        meta = dict(meta, width=width, height=height, tracks=people, risks=risks,
                    people=sum(not p['predicted'] and p['confirmed'] for p in people))
        data = json.dumps(meta,separators=(',',':'),allow_nan=False).encode('utf-8')
        packet = b'PGV1'+struct.pack('>I',len(data))+data+payload
        if len(data)>24*1024 or len(packet)>600*1024:
            raise ValueError('Preview frame exceeds negotiated limit')
        return packet

    def _run(self):
        import websocket
        retry = 1
        while not self.stop_event.is_set():
            ws = None
            revision = self.network_revision() if self.network_revision else None
            try:
                server = self.config['server_url'].rstrip('/')
                address = server.replace('https://','wss://',1).replace('http://','ws://',1)
                factory=self.connect or websocket.create_connection
                ws = factory(address+'/api/device/preview/connect',
                    header=['Authorization: Bearer '+self.config['device_token']],origin=server,
                    timeout=8,enable_multithread=True)
                # Change the receive timeout only while polling. Control and
                # frame writes need a bounded but independent TLS timeout.
                ws.settimeout(2)
                ws.send(json.dumps(dict(type='hello', codecs=['jpeg'], pose=True, camera=True,
                    low_resource=self.config.get('low_resource_preview') is True,
                    frame_ack=True, max_inflight_frames=12)))
                ws.settimeout(.015)
                retry = 1
                applied, ping = -2, time.monotonic()
                in_flight = {}
                window = 1
                uses_credit = False
                while not self.stop_event.is_set():
                    if self.network_revision and self.network_revision() != revision:
                        break
                    try:
                        message = ws.recv()
                        if not message:
                            raise ConnectionError('Preview channel closed')
                        if isinstance(message,str):
                            if len(message)>8192: raise ValueError('Preview control too large')
                            control = json.loads(message)
                            if control.get('type') == 'frame_ack':
                                in_flight.pop((control.get('epoch'), control.get('sequence')), None)
                            if control.get('type')=='control':
                                uses_credit = 'source_window' in control
                                if not uses_credit:
                                    in_flight.clear()
                                window = min(12, max(1, int(control.get('source_window', 1))))
                                camera = control['camera']
                                if str(camera['rotation']) not in ('auto','0','90','180','270'):
                                    raise ValueError('Invalid camera direction')
                                with self.lock:
                                    self.settings = dict(rotation=str(camera['rotation']),mirror=bool(camera['mirror']),version=int(camera['version']))
                                    self.lease = time.monotonic()+min(10000,max(0,control.get('lease_ms',8000)))/1000 if control.get('active') else 0
                                    self.profile = dict(fps=min(20,max(1,control['fps'])),long_side=min(960,max(240,control['long_side'])),quality=min(85,max(25,control['quality'])))
                                    if not control.get('active'): self.pending = None
                                if not self.camera_path.exists() or self.settings != getattr(self,'saved',None):
                                    atomic_json(self.camera_path,self.settings,private=True)
                                    self.saved = dict(self.settings)
                    except (websocket.WebSocketTimeoutException, socket.timeout):
                        pass
                    if in_flight and time.monotonic() - min(in_flight.values()) > 8:
                        raise TimeoutError('Cloud did not acknowledge the source frame')
                    with self.lock:
                        item = None
                        if len(in_flight) < window:
                            item, self.pending = self.pending, None
                        version, lease = self.applied, self.lease
                    if version >= 0 and version != applied:
                        ws.settimeout(2)
                        ws.send(json.dumps(dict(type='applied',version=version)))
                        ws.settimeout(.015)
                        applied = version
                    if item and time.monotonic() < lease:
                        image, tracks, decisions, meta, profile = item
                        payload, width, height, source_width, source_height = self.encode(image,profile)
                        # Detections are normalized against the unscaled inference image.
                        packet = self.packet(payload,source_width,source_height,tracks,decisions,meta)
                        size = struct.unpack_from('>I',packet,4)[0]
                        scaled = json.loads(packet[8:8+size]); scaled.update(width=width,height=height)
                        encoded = json.dumps(scaled,separators=(',',':')).encode()
                        ws.settimeout(2)
                        ws.send_binary(b'PGV1'+struct.pack('>I',len(encoded))+encoded+payload)
                        if uses_credit:
                            in_flight[(meta['source_epoch'], meta['sequence'])] = time.monotonic()
                        ws.settimeout(.015)
                    if time.monotonic()-ping > 25:
                        ws.settimeout(2)
                        ws.ping()
                        ws.settimeout(.015)
                        ping=time.monotonic()
                    self.last_error = ''
            except Exception as error:
                self.last_error = type(error).__name__
                if ws and self.failure_hook:
                    self.failure_hook(ws)
            finally:
                with self.lock:
                    self.lease = 0
                    self.pending = None
                if ws:
                    try: ws.close(timeout=.1)
                    except Exception: pass
            until = time.monotonic() + retry
            while not self.stop_event.is_set() and time.monotonic() < until:
                if self.network_revision and self.network_revision() != revision:
                    break
                self.stop_event.wait(min(.5, max(0, until - time.monotonic())))
            retry = min(30,retry*2)
