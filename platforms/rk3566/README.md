# PoseGuard RK3566 轻量版

在 RK3566 本机完成 H.264 / USB UVC 采集、YOLO11n-Pose 320×320 INT8、17 点解码、多人轨迹、风险状态、JSONL、MIPI 全屏显示及 MJPEG。板上不需要 Python、PyTorch 或云端推理。

## 下载安装

从同仓库 Releases 下载 `PoseGuard-RK3566-v1.1.0-aarch64.tar.gz`、`deploy-adb.ps1` 及 SHA-256 清单。包内包含 C++ 可执行文件、INT8 模型、私有 RKNN Runtime 2.3.2、配置、开机服务及授权说明。

电脑安装 Android platform-tools，连接板子的 USB 调试口：

```powershell
adb devices -l
& .\deploy-adb.ps1 -Serial "你的序列号" -BundlePath ".\PoseGuard-RK3566-v1.1.0-aarch64.tar.gz"
```

安装器核验上传和各文件 SHA-256，在替换文件前进行 NPU 冒烟测试，备份旧文件并保留已有配置。运行库位于 `/userdata/poseguard/lib`，由应用私有路径加载。

部署兼容旧 adbd 缺少远程退出码和精简 BusyBox tar 没有 `-z` 的情况。电脑先展开 gzip，再上传 tar。默认同步电脑 UTC 时间并写入板端 RTC；可用 `-SkipClockSync` 禁用。

电脑预览为 `http://127.0.0.1:18081/`。USB 重连后重新转发：

```powershell
adb -s "你的序列号" forward tcp:18081 tcp:8081
```

板上直接安装：

```sh
gzip -dc PoseGuard-RK3566-v1.1.0-aarch64.tar.gz | tar -xf -
cd poseguard-rk3566
sh install.sh
```

## 视频、MIPI 显示与配置

默认配置为 `/userdata/poseguard/config/poseguard.conf`。默认 USB 摄像头，无摄像头时保持运行、定期重扫。MIPI 输出使用已有 Weston / Wayland，当前实测 DSI 屏 480×800，保持比例全屏显示。屏幕与网页共用一次叠加后的 RGB 帧。

```ini
source=camera
display_enabled=true
loop_video=false
http_enabled=true
http_port=8081
phone_alert_seconds=1.0
multi_person_alert_seconds=0.6
lingering_alert_seconds=20.0
alert_release_seconds=0.8
```

此发布配置将多人确认设为 0.6 秒，以覆盖实测视频开头短暂双人同屏。核心库默认仍是 1.5 秒，应用从配置加载现场阈值。告警会在短时证据抖动后保持红色，超过解除时间才清除。

上传 H.264 / yuv420p / MP4，建议宽高均不低于 240。本次竖屏视频使用 360×640：

```sh
/etc/init.d/S99poseguard stop
/userdata/poseguard/bin/poseguard-run \
  --config /userdata/poseguard/config/poseguard.conf \
  --source video --video /userdata/poseguard/media/test.mp4 \
  --display --benchmark --max-frames 120
```

`--no-display` 关闭屏幕，`--no-http` 关闭网页，`--loop-video` 循环文件。配置 `source=video`、`video=文件路径`、`loop_video=true` 后重启服务即可循环演示。循环会重建轨迹并清除上一轮风险证据。文件输入逐帧回压，摄像头始终取最新帧。

`frames` 是实际完成推理的帧数，`display_rendered` 是显示端实际渲染计数。视频不足 `--max-frames` 时返回非零。排查掉踪时可临时加 `--debug-trace /userdata/poseguard/runs/trace.jsonl`，记录逐帧检测框、关键点分数、轨迹 ID、预测标记及风险状态；默认关闭诊断跟踪。

事件位于 `/userdata/poseguard/runs/events.jsonl`，日志位于 `/userdata/poseguard/logs/poseguard.log`。

```sh
/etc/init.d/S99poseguard start
/etc/init.d/S99poseguard stop
/etc/init.d/S99poseguard restart
/etc/init.d/S99poseguard status
```

HTTP 为 `/`、`/stream.mjpg`、`/status.json`。多个客户端共享一次 JPEG 编码；工作线程及时回收，连接数和显示队列有界。

## 量化与近距离跟踪修正

四路输出为框、人体分数、关键点坐标缓冲和关键点分数。关键点分数直接从与坐标拼接之前的 Sigmoid 分流。仅在混合坐标/分数输出后执行 Gather 仍会丢失置信度精度，导致分数接近 0/1、上半身被质量过滤剔除。

为兼容原有 51 通道坐标缓冲，其中置信度槽位写零；板端使用独立的第四路分数恢复标准 56 通道。高置信度、肩部可靠的近距离上半身观测可以在髋/踝出画时继续跟踪；疑似通话不要求脚踝入画，并利用手臂和头部几何约束。

当前轻量版依靠姿态提示疑似通话，未包含桌面端的独立手机实物确认模型。提示不能判定真实通话、诈骗或违法事实。

## 从源码构建

保留原 Docker 入口 `build.ps1 -Target All`。旧 Buildroot 系统可使用匹配板端库的构建方式。本次构建环境为 Debian 11 / GCC 10.2 / CMake 3.18：

1. 将板端 `/lib`、`/usr/lib` 复制到主机 `board-sysroot/`。
2. 安装 `g++-aarch64-linux-gnu`、`g++`、`cmake`、`ninja-build`、`pkg-config`、`libgstreamer1.0-dev`、`libgstreamer-plugins-base1.0-dev`。
3. 从 Rockchip RKNN Toolkit2 `v2.3.2` 获取 `rknn_api.h` 和 AArch64 `librknnrt.so`，放入 `rknn/include`、`rknn/lib`。

```sh
export BOARD_SYSROOT=/absolute/path/board-sysroot
export RKNN_ROOT=/absolute/path/rknn
sh platforms/rk3566/build-buildroot.sh
```

脚本先运行 5 项本机 C++ 测试，再使用板端 GStreamer、GLib、C 库交叉链接。其他 GCC、固件和运行库组合需要重新验证。原始权重和中间 ONNX 位于同版本 model-sources 发布包；导出、校准、INT8 转换和对比工具位于 `tools/`。

详细实测与限制见 [`../../docs/rk3566-validation-2026-11-13.md`](../../docs/rk3566-validation-2026-11-13.md)。本次使用两段真实视频验证了多人、疑似通话、正常操作和近距离跟踪，并验证 MIPI、并发视频流、循环运行及真实重启。USB 摄像头与热插拔仍需接入摄像头后验证。
