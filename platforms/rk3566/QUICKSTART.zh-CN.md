# RK3566 轻量版离线部署

适用：AArch64 Linux、Rockchip RK3566 NPU、GStreamer/MPP。模型为 YOLO11n-Pose 320×320 INT8，四路独立量化输出，C++17 完成本地姿态、多人跟踪、风险状态、JSONL 和网页预览。板端不需要 Python、PyTorch 或云端服务。

## 通过 USB 安装

安装电脑端 Android platform-tools，连接板子的 USB 调试口。执行 `adb devices -l` 获取序列号。将本文件所在压缩包与源码中的 `platforms/rk3566/deploy-adb.ps1` 放在电脑上：

```powershell
& .\deploy-adb.ps1 -Serial "你的设备序列号" -BundlePath ".\PoseGuard-RK3566-v1.2.0-aarch64.tar.gz"
```

安装前核验整个包的 SHA-256，并在板上进行 NPU 模型冒烟测试。运行库放入 `/userdata/poseguard/lib`，通过应用私有路径加载。升级时备份旧文件并保留已有配置。

电脑打开 `http://127.0.0.1:18081/`。重新连接 USB 后可重新执行端口转发：

```powershell
adb -s "你的设备序列号" forward tcp:18081 tcp:8081
```

有局域网连接时，也可访问 `http://板子IP:8081/`。

## 已在 Linux 板上解压

```sh
gzip -dc PoseGuard-RK3566-v1.2.0-aarch64.tar.gz | tar -xf -
cd poseguard-rk3566
sh install.sh
```

## 测试自己的视频

准备 H.264 / yuv420p / MP4，推荐 640×360 或 640×480。将视频上传到 `/userdata/poseguard/media/test.mp4`，停止摄像头服务后运行：

```sh
/etc/init.d/S99poseguard stop
/userdata/poseguard/bin/poseguard-run \
  --config /userdata/poseguard/config/poseguard.conf \
  --source video --video /userdata/poseguard/media/test.mp4 \
  --max-frames 120 --benchmark --display
```

程序处理实际的 120 帧后退出，打印帧数、最大轨迹数、平均推理耗时、端到端帧率、峰值内存和屏幕渲染计数。视频不足 120 帧时返回非零。省略 `--max-frames` 则处理完整视频；`--no-http` 关闭网页，`--no-display` 关闭屏幕。

MIPI 显示使用板上的 Weston / Wayland，保持比例全屏显示。默认配置为 `display_enabled=true`。视频演示可配置 `source=video`、`video=/userdata/poseguard/media/test.mp4`、`loop_video=true`，然后重启服务。循环时清除上一轮轨迹和风险证据。

多人确认默认 0.6 秒，疑似通话确认 1.0 秒，解除滞回 0.8 秒，可在配置文件中调整。人物靠近镜头只剩上半身时仍可跟踪。排查掉踪可临时使用 `--debug-trace /userdata/poseguard/runs/trace.jsonl`，默认不写逐帧诊断。

USB 部署默认同步 UTC 时间并写入 RTC；可用 `-SkipClockSync` 禁用。USB 重连后需重新转发端口。

默认配置为 USB 摄像头模式，未接摄像头时保持运行、定期重扫并显示等待画面。恢复默认服务：

```sh
/etc/init.d/S99poseguard start
/etc/init.d/S99poseguard status
tail -f /userdata/poseguard/logs/poseguard.log
```

配置：`/userdata/poseguard/config/poseguard.conf`。事件：`/userdata/poseguard/runs/events.jsonl`。默认不保存原始画面。风险提示仅供现场人工关注，不能判定诈骗或违法事实。当前板端版本以贴耳姿态提示疑似通话，未部署桌面端的独立手机实物确认模型。

## 模型与来源

1.2.0 包含云端接入中继。设备联网后按包内 `CLOUD.md` 完成绑定，可同步第 101 帧告警、目标截图和工作人员介入请求。

原始权重：Ultralytics `yolo11n-pose.pt`，来源为 `https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n-pose.pt`。转换工具：Rockchip RKNN Toolkit2 2.3.2。权重和中间 ONNX 随同版本的 model-sources 压缩包提供。第三方授权文本位于 `licenses/`；转换、构建和应用源码位于同一 GitHub Release 对应标签。

详细实测环境与限制见压缩包内 `validation.md` 和仓库的 `docs/rk3566-validation-2026-11-13.md`。视频样本用于本机测试，不随发布包分发。
