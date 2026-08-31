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
