"""Package the committed MaixCAM runtime as an installer or a launcher ZIP."""
import argparse
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import zipfile

NATIVE_MAIN = """from pathlib import Path

from app_entry import main

if __name__ == "__main__":
    raise SystemExit(main(runtime_directory=Path(__file__).resolve().parent / "runtime"))
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--native", action="store_true", help="Build a Maix app_store_cli ZIP")
    parser.add_argument("--qa", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True).strip() and not args.qa:
        raise SystemExit("Commit the final source before packaging.")
    board = root / "platforms/maixcam"
    metadata = (board / "app.yaml").read_text(encoding="utf-8")
    version = re.search(r"^version: ([0-9]+\.[0-9]+\.[0-9]+)$", metadata, re.MULTILINE).group(1)
    stage = args.output / ("poseguard" if args.native else f"PoseGuard-MaixCAM-v{version}")
    runtime = stage / "runtime"
    runtime.mkdir(parents=True)
    for relative in ("main.py", "config.py", "cloud_network.py", "ca-bundle.pem", "event_store.py",
                     "pose_adapter.py", "risk_core.py", "screen.py", "track_core.py"):
        shutil.copyfile(board / relative, runtime / relative)
    for source, target in (("edge", "poseguard_cloud"), ("preview", "cloud_preview"),
                           ("orientation", "cloud_orientation")):
        shutil.copyfile(root / "poseguard/cloud" / (source + ".py"), runtime / (target + ".py"))
    (runtime / "VERSION").write_text(version + "\n", encoding="ascii")
    if args.native:
        launcher = stage
        (launcher / "main.py").write_text(NATIVE_MAIN, encoding="utf-8")
        shutil.copyfile(board / "app_entry.py", launcher / "app_entry.py")
    else:
        launcher = stage / "launcher"
        launcher.mkdir()
        shutil.copyfile(board / "app_entry.py", launcher / "main.py")
        shutil.copyfile(board / "install.py", stage / "install.py")
    (launcher / "app.yaml").write_text(metadata, encoding="utf-8")
    shutil.copyfile(root / "cloud/poseguard-hub/public/icons/icon-192.png", launcher / "icon.png")
    shutil.copyfile(root / "docs/MAIXCAM.zh-CN.md", stage / "README.zh-CN.md")
    shutil.copyfile(root / "docs/edge-validation-2026-11-17.md", stage / "edge-validation-2026-11-17.md")
    shutil.copyfile(root / "LICENSES.md", stage / "LICENSES.md")
    shutil.copyfile(root / "licenses/Certifi-MPL-2.0.txt", stage / "Certifi-LICENSE.txt")
    (stage / "VERSION").write_text(version + "\n", encoding="ascii")
    (stage / "SOURCE_COMMIT.txt").write_text(commit + ("-WORKTREE-QA" if args.qa else "") + "\n", encoding="utf-8")
    entries = [hashlib.sha256(file.read_bytes()).hexdigest() + "  " + file.relative_to(stage).as_posix()
               for file in sorted(stage.rglob("*")) if file.is_file()]
    (stage / "FILES.sha256").write_bytes(("\n".join(entries) + "\n").encode("utf-8"))
    if args.native:
        target = args.output / f"poseguard_v{version}.zip"
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for file in sorted(stage.rglob("*")):
                if file.is_file():
                    archive.write(file, file.relative_to(stage.parent).as_posix())
    else:
        target = args.output / (stage.name + ".tar.gz")
        with tarfile.open(target, "w:gz") as archive:
            archive.add(stage, arcname=stage.name)
    print(target, target.stat().st_size, hashlib.sha256(target.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
