# PoseGuard Windows User Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a beginner-friendly GitHub download path plus one-time Windows setup and daily launch scripts.

**Architecture:** Two root-level batch files keep the user interaction to double-click actions. The setup script creates an isolated Python 3.11 virtual environment, installs pinned dependencies, and downloads the two configured YOLO models into `models`; the run script validates those artifacts before launching the existing application. README documents both the graphical workflow and equivalent PowerShell commands.

**Tech Stack:** Windows batch, Python 3.11 virtual environments, pip, Ultralytics, pytest, Markdown

---

## File structure

- Create `setup_windows.bat`: one-time environment and model initialization.
- Create `run_windows.bat`: repeatable default-camera launcher with prerequisite checks.
- Create `tests/test_windows_launchers.py`: static contract tests for safe paths, required artifacts, and launcher commands.
- Modify `README.md`: ordinary-user download, setup, launch, manual fallback, controls, and troubleshooting.

### Task 1: Windows first-run setup

**Files:**
- Create: `setup_windows.bat`
- Create: `tests/test_windows_launchers.py`

- [ ] **Step 1: Write the failing setup contract test**

```python
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_setup_launcher_creates_environment_and_fetches_models():
    content = (ROOT / "setup_windows.bat").read_text(encoding="utf-8")
    assert 'cd /d "%~dp0"' in content
    assert "py -3" in content
    assert "-m venv .venv" in content
    assert "requirements.txt" in content
    assert "yolo11n-pose.pt" in content
    assert "yolo11n.pt" in content
```

- [ ] **Step 2: Run the test and verify the missing launcher fails**

Run: `python -m pytest tests/test_windows_launchers.py::test_setup_launcher_creates_environment_and_fetches_models -q`

Expected: FAIL with `FileNotFoundError` for `setup_windows.bat`.

- [ ] **Step 3: Create the setup launcher**

Implement `setup_windows.bat` with these actions in order:

```bat
@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PY_CMD="
where py >nul 2>&1 && py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1 && set "PY_CMD=py -3"
if not defined PY_CMD where python >nul 2>&1 && python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1 && set "PY_CMD=python"
if not defined PY_CMD goto :no_python
echo [1/4] 正在创建 Python 虚拟环境...
%PY_CMD% -m venv .venv || goto :failed
echo [2/4] 正在升级 pip...
".venv\Scripts\python.exe" -m pip install --upgrade pip || goto :failed
echo [3/4] 正在安装 PoseGuard 依赖...
".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :failed
if not exist models mkdir models
echo [4/4] 正在获取姿态与目标检测模型...
pushd models
"..\.venv\Scripts\python.exe" -c "from ultralytics import YOLO; YOLO('yolo11n-pose.pt'); YOLO('yolo11n.pt')"
if errorlevel 1 (popd & goto :model_failed)
popd
echo.
echo 初始化完成。以后双击 run_windows.bat 即可启动。
pause
exit /b 0

:no_python
echo [错误] 未找到 Python 3.11 或更高版本。
echo 请从 https://www.python.org/downloads/ 安装 64 位 Python 3.11，并勾选 Add Python to PATH。
pause
exit /b 1

:model_failed
echo [错误] 模型获取失败。请检查网络连接后重新运行 setup_windows.bat。
pause
exit /b 2

:failed
echo [错误] 环境初始化失败。请保留窗口中的错误信息并重新运行本脚本。
pause
exit /b 3
```

- [ ] **Step 4: Run the setup contract test**

Run: `python -m pytest tests/test_windows_launchers.py::test_setup_launcher_creates_environment_and_fetches_models -q`

Expected: PASS.

- [ ] **Step 5: Commit the setup launcher**

```bash
git add setup_windows.bat tests/test_windows_launchers.py
git commit -m "feat: add Windows first-run setup launcher"
```

### Task 2: Windows daily launcher

**Files:**
- Create: `run_windows.bat`
- Modify: `tests/test_windows_launchers.py`

- [ ] **Step 1: Write the failing run contract test**

```python
def test_run_launcher_checks_runtime_files_and_starts_poseguard():
    content = (ROOT / "run_windows.bat").read_text(encoding="utf-8")
    assert 'cd /d "%~dp0"' in content
    assert ".venv\\Scripts\\python.exe" in content
    assert "models\\yolo11n-pose.pt" in content
    assert "models\\yolo11n.pt" in content
    assert "-m poseguard.app" in content
    assert "configs/windows.json" in content
```

- [ ] **Step 2: Run the test and verify the missing launcher fails**

Run: `python -m pytest tests/test_windows_launchers.py::test_run_launcher_checks_runtime_files_and_starts_poseguard -q`

Expected: FAIL with `FileNotFoundError` for `run_windows.bat`.

- [ ] **Step 3: Create the run launcher**

Create `run_windows.bat` with this complete content:

```bat
@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "APP_PY=.venv\Scripts\python.exe"
if not exist "%APP_PY%" goto :not_ready
if not exist "models\yolo11n-pose.pt" goto :not_ready
if not exist "models\yolo11n.pt" goto :not_ready
"%APP_PY%" -m poseguard.app --source 0 --config configs/windows.json
set "APP_EXIT=%ERRORLEVEL%"
if not "%APP_EXIT%"=="0" (
    echo.
    echo [错误] PoseGuard 运行失败，退出代码：%APP_EXIT%
    pause
)
exit /b %APP_EXIT%

:not_ready
echo [错误] 运行环境或模型文件不完整。
echo 请先双击 setup_windows.bat 完成首次初始化。
pause
exit /b 1
```

- [ ] **Step 4: Run launcher tests**

Run: `python -m pytest tests/test_windows_launchers.py -q`

Expected: 2 passed.

- [ ] **Step 5: Commit the daily launcher**

```bash
git add run_windows.bat tests/test_windows_launchers.py
git commit -m "feat: add Windows daily run launcher"
```

### Task 3: README ordinary-user quick start

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the quick-start section after the safety disclaimer**

Insert a `## 普通用户快速开始（Windows）` section containing this user flow:

```markdown
## 普通用户快速开始（Windows）

### 运行条件

- 64 位 Windows 10 或 Windows 11；
- Python 3.11 或更高版本；
- 内置摄像头或 USB 摄像头；
- 首次初始化时需要联网安装依赖和获取模型。

安装 Python 时请勾选 `Add Python to PATH`。

### 1. 从 GitHub 下载

正式发布包可在 [Releases](https://github.com/nanaoniiiii/Finance-Anti-fraud-visual-model/releases) 页面下载。若 Releases 页面暂时没有安装包，可返回仓库首页，点击绿色 `Code` 按钮，再选择 `Download ZIP` 下载当前源码。

下载后解压 ZIP，进入包含 `README.md`、`setup_windows.bat` 和 `run_windows.bat` 的目录。普通用户不需要安装 Git。

### 2. 首次初始化

双击 `setup_windows.bat`。脚本会创建独立运行环境、安装依赖，并获取人体姿态与目标检测模型。根据网络和电脑性能，首次安装可能需要几分钟。

看到“初始化完成”后即可关闭窗口。该步骤通常只需执行一次。

### 3. 启动程序

连接摄像头后双击 `run_windows.bat`。默认打开编号为 `0` 的摄像头。

- 按 `p`：暂停或继续；
- 按 `q` 或 `Esc`：退出。

风险事件默认记录到 `runs/events.jsonl`，不会保存原始视频、图片、人脸或完整关键点。
```

- [ ] **Step 2: Add the manual PowerShell fallback**

Add these exact PowerShell commands below `### 手动安装与运行`:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
New-Item -ItemType Directory -Force models | Out-Null
Push-Location models
..\.venv\Scripts\python.exe -c "from ultralytics import YOLO; YOLO('yolo11n-pose.pt'); YOLO('yolo11n.pt')"
Pop-Location
.\.venv\Scripts\python.exe scripts\check_windows.py --source 0
.\.venv\Scripts\python.exe -m poseguard.app --source 0 --config configs\windows.json
```

Add video launch as:

```powershell
.\.venv\Scripts\python.exe -m poseguard.app --source "C:\path\to\test.mp4" --config configs\windows.json
```

- [ ] **Step 3: Add concise troubleshooting**

Add this troubleshooting list:

```markdown
### 常见问题

- 提示找不到 Python：安装 64 位 Python 3.11，并在安装器中勾选 `Add Python to PATH`。
- 模型获取失败：确认网络可访问模型下载地址，然后重新双击 `setup_windows.bat`。
- 摄像头打不开：关闭微信、浏览器等占用摄像头的软件；若电脑有多个摄像头，手动命令中的 `--source 0` 可改为 `--source 1`。
- 画面帧率较低：CPU 模式仍可运行，但速度通常低于 NVIDIA CUDA 环境；可降低摄像头分辨率或后续安装匹配显卡的 PyTorch。
- 环境或依赖损坏：删除 `.venv` 文件夹后重新运行 `setup_windows.bat`。
```

- [ ] **Step 4: Verify README commands and full test suite**

Run:

```powershell
python -m poseguard.app --help
python scripts/check_windows.py --help
python -m pytest -q
git diff --check
```

Expected: both help commands exit 0, all tests pass, and `git diff --check` reports no errors.

- [ ] **Step 5: Commit the user documentation**

```bash
git add README.md
git commit -m "docs: add Windows user quick start"
```

### Task 4: Push documentation and launchers

**Files:**
- No additional file changes.

- [ ] **Step 1: Confirm public-release exclusions**

Run: `git status --short --branch` and verify software-copyright materials, model weights, videos, and generated environments are not staged.

- [ ] **Step 2: Push main**

Run: `git push github main`

Expected: GitHub `main` advances to the README commit without force-push.

- [ ] **Step 3: Verify remote main**

Run: `git fetch github --prune` followed by `git rev-list --left-right --count main...github/main`.

Expected: `0 0`.
