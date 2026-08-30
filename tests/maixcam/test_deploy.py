from pathlib import Path

from platforms.maixcam.deploy import runtime_files


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
