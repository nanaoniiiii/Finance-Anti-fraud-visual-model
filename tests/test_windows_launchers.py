from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("filename", ("setup_windows.bat", "run_windows.bat"))
def test_windows_launcher_uses_crlf_line_endings(filename):
    content = (ROOT / filename).read_bytes()

    assert b"\r\n" in content
    assert b"\n" not in content.replace(b"\r\n", b"")


def test_setup_launcher_creates_environment_and_fetches_models():
    content = (ROOT / "setup_windows.bat").read_text(encoding="utf-8")

    assert 'cd /d "%~dp0"' in content
    assert "py -3" in content
    assert "-m venv .venv" in content
    assert "requirements.txt" in content
    assert "yolo11n-pose.pt" in content
    assert "yolo11n.pt" in content


def test_run_launcher_checks_runtime_files_and_starts_poseguard():
    content = (ROOT / "run_windows.bat").read_text(encoding="utf-8")

    assert 'cd /d "%~dp0"' in content
    assert ".venv\\Scripts\\python.exe" in content
    assert "models\\yolo11n-pose.pt" in content
    assert "models\\yolo11n.pt" in content
    assert "-m poseguard.app" in content
    assert "configs/windows.json" in content
