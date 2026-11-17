"""Install a checksummed MaixCAM runtime and optionally set its launcher auto-start."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

APPLICATIONS = Path("/maixapp/apps")
AUTO_START = APPLICATIONS.parent / "auto_start.txt"
DATA = Path("/root/poseguard-data/maix")
ROOT = Path("/root/poseguard-maix")


def atomic_write(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    with os.fdopen(fd, "wb") as stream:
        os.fchmod(stream.fileno(), mode)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(name, path)


def verify_bundle(bundle):
    manifest = (bundle / "FILES.sha256").read_bytes()
    for row in manifest.decode("utf-8").splitlines():
        digest, relative = row.split("  ", 1)
        path = bundle / relative
        if not path.is_relative_to(bundle) or not path.resolve().is_relative_to(bundle):
            raise ValueError("Invalid bundle path")
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError("Incorrect file checksum for " + relative)
    return hashlib.sha256(manifest).hexdigest()[:12]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--autostart", action="store_true")
    parser.add_argument("--bind", action="store_true", help="Read a fresh one-time binding code securely")
    parser.add_argument("--server", default="https://poseguard.nanaoni.tech")
    args = parser.parse_args()
    if os.geteuid() or not (APPLICATIONS / "gen_app_info.py").is_file():
        raise SystemExit("Run this installer as root on a MaixPy 4 board.")
    if not Path("/root/models/yolo11n_pose.mud").is_file():
        raise SystemExit("Install the Sipeed YOLO11n Pose model first.")
    import importlib.util
    if any(importlib.util.find_spec(name) is None for name in ("maix", "websocket")):
        raise SystemExit("MaixPy 4 and websocket-client are required on the board.")
    bundle = Path(__file__).resolve().parent
    digest = verify_bundle(bundle)
    version = (bundle / "VERSION").read_text().strip()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise SystemExit("Invalid bundle version")
    release = ROOT / "releases" / (version + "-" + digest)
    release.parent.mkdir(parents=True, exist_ok=True)
    if not release.exists():
        stage = Path(tempfile.mkdtemp(prefix=".install-", dir=release.parent))
        shutil.copytree(bundle / "runtime", stage, dirs_exist_ok=True)
        subprocess.run([sys.executable, "-m", "compileall", "-q", str(stage)], check=True)
        stage.rename(release)
    for original in (bundle / "runtime").iterdir():
        if original.is_file() and (release / original.name).read_bytes() != original.read_bytes():
            raise SystemExit("Existing release has different files. Its directory was preserved.")

    DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
    config_path = DATA / "binding.json"
    settings_path = DATA / "runtime.json"
    previous = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    if args.bind:
        if config_path.exists() or previous.get("cloud_config"):
            raise SystemExit("This board already has a binding. Use the existing identity or rebind it deliberately.")
        import getpass
        sys.path.insert(0, str(release))
        from cloud_network import MaixNetwork
        from poseguard_cloud import enroll
        code = getpass.getpass("One-time MaixCAM binding code: ").strip()
        if not code:
            raise SystemExit("A binding code is required")
        enrolled = enroll(args.server, code, "maixcam", config_path, transport=MaixNetwork().http_json)
        print("Bound device " + enrolled["device_id"])

    app = APPLICATIONS / "poseguard"
    backup = Path(tempfile.mkdtemp(prefix="launcher-", dir=DATA))
    changes = {app / "main.py": (bundle / "launcher/main.py").read_bytes(),
               app / "app.yaml": (bundle / "launcher/app.yaml").read_bytes()}
    settings = {**previous, "runtime_directory": str(release),
                "data_directory": previous.get("data_directory", str(DATA))}
    if config_path.exists():
        settings["cloud_config"] = str(config_path)
    changes[settings_path] = (json.dumps(settings, ensure_ascii=False) + "\n").encode("utf-8")
    if args.autostart:
        changes[AUTO_START] = b"poseguard"
    registry = APPLICATIONS / "app.info"
    prior = {path: path.read_bytes() if path.exists() else None for path in (*changes, registry)}
    for path, data in prior.items():
        if data is not None:
            atomic_write(backup / path.relative_to("/"), data)
    try:
        for path, data in changes.items():
            atomic_write(path, data, 0o644 if path.parent == app or path == AUTO_START else 0o600)
        subprocess.run([sys.executable, str(APPLICATIONS / "gen_app_info.py"), str(APPLICATIONS)], check=True)
    except Exception:
        for path, data in prior.items():
            if data is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, data, 0o600 if path == settings_path else 0o644)
        raise
    print(f"Installed {release}")
    print(f"Previous launcher settings: {backup}")
    print("Open PoseGuard in the launcher or reboot after selecting --autostart.")


if __name__ == "__main__":
    main()
