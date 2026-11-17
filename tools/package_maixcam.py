"""Package the committed MaixCAM installer and board runtime."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tarfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--qa", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True).strip() and not args.qa:
        raise SystemExit("Commit the final source before packaging.")
    stage = args.output / "PoseGuard-MaixCAM-v1.6.0"
    runtime = stage / "runtime"
    runtime.mkdir(parents=True)
    launcher = stage / "launcher"
    launcher.mkdir()
    board = root / "platforms/maixcam"
    for relative in ("main.py", "config.py", "cloud_network.py", "ca-bundle.pem", "event_store.py",
                     "pose_adapter.py", "risk_core.py", "screen.py", "track_core.py"):
        shutil.copyfile(board / relative, runtime / relative)
    for source, target in (("edge", "poseguard_cloud"), ("preview", "cloud_preview"),
                           ("orientation", "cloud_orientation")):
        shutil.copyfile(root / "poseguard/cloud" / (source + ".py"), runtime / (target + ".py"))
    shutil.copyfile(board / "app_entry.py", launcher / "main.py")
    shutil.copyfile(board / "app.yaml", launcher / "app.yaml")
    shutil.copyfile(board / "install.py", stage / "install.py")
    shutil.copyfile(root / "docs/MAIXCAM.zh-CN.md", stage / "README.zh-CN.md")
    shutil.copyfile(root / "docs/edge-validation-2026-11-17.md", stage / "edge-validation-2026-11-17.md")
    shutil.copyfile(root / "LICENSES.md", stage / "LICENSES.md")
    shutil.copyfile(root / "licenses/Certifi-MPL-2.0.txt", stage / "Certifi-LICENSE.txt")
    (stage / "VERSION").write_text("1.6.0\n", encoding="utf-8")
    (stage / "SOURCE_COMMIT.txt").write_text(commit + ("-WORKTREE-QA" if args.qa else "") + "\n", encoding="utf-8")
    entries = [hashlib.sha256(file.read_bytes()).hexdigest() + "  " + file.relative_to(stage).as_posix()
               for file in sorted(stage.rglob("*")) if file.is_file()]
    (stage / "FILES.sha256").write_bytes(("\n".join(entries) + "\n").encode("utf-8"))
    target = args.output / (stage.name + ".tar.gz")
    with tarfile.open(target, "w:gz") as archive:
        archive.add(stage, arcname=stage.name)
    print(target, target.stat().st_size, hashlib.sha256(target.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
