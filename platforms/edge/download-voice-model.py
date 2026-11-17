"""Prepare a pinned local Mandarin/multilingual Whisper deployment directory."""

import argparse
import hashlib
from pathlib import Path
import subprocess

REVISION = "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"
BASE = f"https://huggingface.co/Systran/faster-whisper-base/resolve/{REVISION}/"
FILES = {
    "config.json": 2309,
    "model.bin": 145217532,
    "tokenizer.json": 2203239,
    "vocabulary.txt": 459861,
}
MODEL_SHA256 = "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9"


def verified(path, name):
    if not path.is_file() or path.stat().st_size != FILES[name]:
        return False
    if name == "model.bin":
        with path.open("rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest() == MODEL_SHA256
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    arguments = parser.parse_args()
    arguments.output.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        target = arguments.output / name
        if verified(target, name):
            continue
        if target.exists():
            raise RuntimeError("Existing model file differs from the pinned download: " + name)
        partial = target.with_suffix(target.suffix + ".part")
        subprocess.run(
            ["curl", "-fL", "--proto", "=https", "--connect-timeout", "20",
             "--retry", "2", "--max-time", "1800", BASE + name + "?download=true",
             "-o", str(partial)],
            check=True,
        )
        if not verified(partial, name):
            raise RuntimeError("Failed checksum or size check for " + name)
        partial.replace(target)
    print(arguments.output.resolve())


if __name__ == "__main__":
    main()
