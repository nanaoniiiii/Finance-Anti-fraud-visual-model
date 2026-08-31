# PoseGuard RK3566 验证记录

日期：2026-08-31

## 已完成的本机验证

- Windows 项目测试：167 passed。
- RK3566 C++ 测试：5/5 passed，覆盖基础类型、三类风险、17 点解码、UVC 节点选择、叠加与 JSONL 状态变化。
- YOLO11n-Pose ONNX：静态输入 320×320；导出端把 `[1,56,2100]` 拆为框、人体分数、关键点和关键点分数四路输出，避免混合数值范围共用一个 INT8 尺度。板端重组后仍按原 56 通道解码。
- 校准输入：从 631 帧瑜伽视频均匀抽取 40 张；另留 3 张做量化前后比较。
- RKNN Toolkit2 2.3.2 量化比较：3/3 留出帧通过；框 IoU 分别为 0.963、0.934、0.904，关键点平均误差/人体高度分别为 3.33%、2.92%、3.05%。
- INT8 RKNN：4,339,784 bytes，SHA-256 `5eb2eee1c7c60917c07f42a48c43d1551d5deb3d713f6067ac96d4eafd010f12`。
- 回归视频：960×540、30 FPS、H.264、yuv420p。
- 完整板端代码（RKNN、GStreamer、V4L2、JPEG、HTTP）已用 AArch64 工具链编译并动态链接；ELF64 machine 为 183，SHA-256 `44031261ca5bbce7266c40bee30460d4c405b3828a7abec6deecbfafec331b3`。
- UVC 实现不依赖固定 `/dev/video9`，主机夹具验证会排除 RKISP 和 metadata 节点。

## 已完成的泰山派实测

- 设备：泰山派 RK3566，Buildroot Linux 6.1.141，AArch64。
- RKNN：Runtime `2.3.2 (429f97ae6b@2025-04-09T09:09:27)`，驱动 `0.9.8`。
- 模型冒烟：四路输出在板端重组为 `[1,56,2100]`，空白输入推理 40.691 ms，退出码 0。
- 本地 H.264 视频：MPP 解码 120 帧，`max_tracks=1`，平均推理 17.89 ms，端到端 6.93 FPS，峰值 RSS 32,520 KB，退出码 0。
- 部署：二进制、模型、配置、视频和服务脚本均经本机/板端 SHA-256 对比后原子替换。
- HTTP：未接 USB 时 `/status.json` 返回 `input_state=waiting_for_usb_camera`，进程不退出。
- 开机：执行一次真实重启；开机 0 分钟时 `/etc/init.d/S99poseguard status` 为 running（PID 859），HTTP 可访问。
- 重启后二进制与模型 SHA-256 再次核对一致。

## 后续接入 USB 摄像头时补测

- 完整瑜伽视频回放、MJPEG、JSONL；
- USB 摄像头接入和热插拔实测。

执行入口：

```powershell
& platforms/rk3566/deploy.ps1
```

部署后先运行：

```sh
/userdata/poseguard/bin/poseguard-rk3566 --model-smoke \
  /userdata/poseguard/models/poseguard-yolo11n-pose-320-int8.rknn

/userdata/poseguard/bin/poseguard-rk3566 \
  --config /userdata/poseguard/config/poseguard.conf \
  --source video --video /userdata/poseguard/media/yoga-regression.mp4 \
  --benchmark --max-frames 120 --no-http
```
