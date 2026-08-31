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
pushd models || goto :failed
"..\.venv\Scripts\python.exe" -c "from ultralytics import YOLO; YOLO('yolo11n-pose.pt'); YOLO('yolo11n.pt')"
if errorlevel 1 goto :model_failed_from_models
popd

echo.
echo 初始化完成。以后双击 run_windows.bat 即可启动。
pause
exit /b 0

:model_failed_from_models
popd

:model_failed
echo [错误] 模型获取失败。请检查网络连接后重新运行 setup_windows.bat。
pause
exit /b 2

:no_python
echo [错误] 未找到 Python 3.11 或更高版本。
echo 请从 https://www.python.org/downloads/ 安装 64 位 Python，并勾选 Add Python to PATH。
pause
exit /b 1

:failed
echo [错误] 环境初始化失败。请保留窗口中的错误信息并重新运行本脚本。
pause
exit /b 3
