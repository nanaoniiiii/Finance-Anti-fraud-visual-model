from pathlib import Path

import pytest

from platforms.maixcam.deploy import runtime_files, validate_remote_dir


def test_runtime_files_include_only_board_modules(tmp_path):
    for name in ("main.py", "config.py", "deploy.py", "deploy.ps1", "notes.txt"):
        (tmp_path / name).write_text(name, encoding="utf-8")
    (tmp_path / "__pycache__").mkdir()
    (tmp_path / "__pycache__" / "main.pyc").write_bytes(b"cache")

    names = [path.name for path in runtime_files(tmp_path)]

    assert names == ["config.py", "main.py"]


def test_runtime_files_are_sorted(tmp_path):
    for name in ("zeta.py", "alpha.py", "screen.py"):
        (tmp_path / name).write_text(name, encoding="utf-8")

    assert [path.name for path in runtime_files(Path(tmp_path))] == [
        "alpha.py",
        "screen.py",
        "zeta.py",
    ]


@pytest.mark.parametrize(
    "remote_dir",
    ("/root", "/root/", "/root/.", "/"),
)
def test_validate_remote_dir_rejects_launcher_locations(remote_dir):
    with pytest.raises(ValueError, match="protected"):
        validate_remote_dir(remote_dir)


def test_validate_remote_dir_accepts_poseguard_directory():
    assert validate_remote_dir("/root/poseguard_maix") == "/root/poseguard_maix"
