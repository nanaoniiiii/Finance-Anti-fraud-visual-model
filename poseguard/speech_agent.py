"""Local microphone/Whisper adapter for the PoseGuard station service."""

import argparse
import datetime
import json
import math
import os
from pathlib import Path
import queue
import sys
import time
import urllib.request
from uuid import uuid4

from .speech_risk import cues

MIN_CAPTURE_RMS = .001
MIN_SIGNAL_CONFIDENCE = .42

def read_config(path):
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    return value["server_url"], value["device_token"]


def post(server, token, path, value):
    from .cloud.edge import valid_server
    request = urllib.request.Request(
        valid_server(server) + path,
        data=json.dumps(value, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


class SpeechModel:
    def __init__(self, model_path, threads):
        from faster_whisper import WhisperModel

        if not (Path(model_path) / "model.bin").is_file():
            raise ValueError("Provide an already downloaded multilingual Whisper model directory")
        self.model = WhisperModel(
            str(model_path), device="cpu", compute_type="int8",
            cpu_threads=threads, num_workers=1, local_files_only=True,
        )

    def detect(self, audio):
        import numpy as np

        if isinstance(audio, np.ndarray) and (
            not len(audio) or np.sqrt(np.mean(audio * audio)) < MIN_CAPTURE_RMS
        ):
            return [], 0.0
        segments, _ = self.model.transcribe(
            audio, language="zh", beam_size=3, temperature=0,
            condition_on_previous_text=False, vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 350},
        )
        fragments = [
            (segment.text, segment.avg_logprob)
            for segment in segments
            if segment.no_speech_prob < .65 and segment.avg_logprob > -1.10
        ]
        if not fragments:
            return [], 0.0
        codes = cues("。".join(fragment for fragment, _ in fragments))
        confidence = math.exp(sum(score for _, score in fragments) / len(fragments))
        return codes, round(confidence, 3)


def resample(samples, source_hz, output_hz=16000):
    import av
    import numpy as np

    samples = np.asarray(samples, dtype="float32").reshape(-1)
    if source_hz == output_hz or not len(samples):
        return samples
    frame = av.AudioFrame.from_ndarray(samples.reshape(1, -1), format="fltp", layout="mono")
    frame.sample_rate = source_hz
    resampler = av.AudioResampler(format="fltp", layout="mono", rate=output_hz)
    rendered = resampler.resample(frame) + resampler.resample(None)
    return np.concatenate([part.to_ndarray().reshape(-1) for part in rendered], dtype="float32")


def playback_capture(file, input_device=None, output_device=None):
    """Play a synthetic WAV through an output device and capture a real input."""
    import numpy as np
    import sounddevice as sd
    import wave

    with wave.open(str(file), "rb") as voice:
        if voice.getnchannels() != 1 or voice.getsampwidth() != 2:
            raise ValueError("Test WAV must be PCM 16-bit mono")
        samples = np.frombuffer(voice.readframes(voice.getnframes()), dtype="<i2").astype("float32") / 32768
        source_rate = voice.getframerate()
    sample_rate = int(sd.query_devices(input_device, "input")["default_samplerate"])
    output_rate = int(sd.query_devices(output_device, "output")["default_samplerate"])
    recording = np.zeros(int((len(samples) / source_rate + 1.5) * sample_rate), dtype="float32")
    position, dropped = 0, False

    def capture(indata, frames, _timing, status):
        nonlocal position, dropped
        dropped |= bool(status)
        take = min(frames, len(recording) - position)
        recording[position:position + take] = indata[:take, 0]
        position += take

    with sd.InputStream(device=input_device, samplerate=sample_rate, channels=1, dtype="float32", callback=capture):
        time.sleep(.3)
        mono = resample(samples, source_rate, output_rate)
        with sd.OutputStream(device=output_device, samplerate=output_rate, channels=1, dtype="float32") as speaker:
            speaker.write(mono.reshape(-1, 1) * .55)
        time.sleep(.7)
    if position == 0 or dropped:
        raise RuntimeError("Microphone capture failed or dropped samples")
    actual = recording[:position]
    return resample(actual, sample_rate), {
        "capture_mode": "speaker_to_microphone",
        "captured_seconds": round(position / sample_rate, 3),
        "peak": round(float(np.max(np.abs(actual))), 4),
        "rms": round(float(np.sqrt(np.mean(actual * actual))), 4),
    }


def listen(input_device, seconds):
    """Bound the live queue and retain speech only in memory."""
    import sounddevice as sd

    sample_rate = int(sd.query_devices(input_device, "input")["default_samplerate"])
    waiting = queue.Queue(maxsize=2)

    def capture(block, _count, _time, status):
        if status:
            return
        if waiting.full():
            try:
                waiting.get_nowait()
            except queue.Empty:
                pass
        try:
            waiting.put_nowait((block[:, 0].copy(), time.time()))
        except queue.Full:
            pass

    with sd.InputStream(
        device=input_device, samplerate=sample_rate, channels=1, dtype="float32",
        callback=capture, blocksize=round(sample_rate * seconds),
    ):
        while True:
            samples, captured = waiting.get(timeout=seconds + 5)
            yield resample(samples, sample_rate), captured


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--binding", type=Path)
    parser.add_argument("--input-device", type=int)
    parser.add_argument("--output-device", type=int)
    parser.add_argument("--threads", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--seconds", type=float, default=6)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--mic", action="store_true")
    modes.add_argument("--wav", type=Path)
    modes.add_argument("--play-test", type=Path)
    args = parser.parse_args()
    if not 3 <= args.seconds <= 15 or not 1 <= args.threads <= 16:
        parser.error("Use a 3–15 second window and 1–16 CPU threads")
    model = SpeechModel(args.model, args.threads)
    server, token = read_config(args.binding) if args.binding else (None, None)

    def submit(audio, captured, details=None):
        start = time.monotonic()
        evidence, confidence = model.detect(audio)
        report = dict(details or {}, codes=evidence, confidence=confidence,
                      recognition_ms=round((time.monotonic() - start) * 1000))
        if server and evidence and confidence >= MIN_SIGNAL_CONFIDENCE:
            stamp = datetime.datetime.fromtimestamp(captured, datetime.timezone.utc).isoformat()
            result = post(server, token, "/api/device/signals", {
                "signal_id": uuid4().hex, "captured_at": stamp,
                "codes": evidence, "confidence": confidence,
            })
            report["station"] = {key: result.get(key) for key in ("level", "score", "incident_id")}
        print(json.dumps(report, ensure_ascii=False), flush=True)

    if args.play_test:
        samples, metrics = playback_capture(args.play_test, args.input_device, args.output_device)
        if metrics["rms"] < MIN_CAPTURE_RMS:
            print(json.dumps({**metrics, "status": "insufficient_microphone_input"}), flush=True)
            raise SystemExit(2)
        submit(samples, time.time(), metrics)
    elif args.wav:
        submit(str(args.wav), time.time(), {"capture_mode": "wav_file"})
    else:
        heartbeat_due = 0
        for audio, captured in listen(args.input_device, args.seconds):
            if server and time.monotonic() >= heartbeat_due:
                heartbeat_due = time.monotonic() + 30
                try:
                    post(server, token, "/api/device/heartbeat", {
                        "mode": "running", "firmware": "poseguard-speech/1.7",
                        "clock_synced": True, "capabilities": {"speech": True},
                    })
                except (OSError, ValueError) as error:
                    print(f"Heartbeat: {type(error).__name__}", file=sys.stderr, flush=True)
            try:
                submit(audio, captured)
            except (OSError, ValueError) as error:
                print(type(error).__name__, file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
