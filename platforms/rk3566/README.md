# PoseGuard for TaishanPi RK3566

该目录是独立的泰山派端侧版本：USB 摄像头或本地 H.264 视频进入 GStreamer，YOLO11n-Pose 320×320 INT8 由 RKNN 推理，随后在板端完成 17 点解码、多人轨迹、贴耳/多人/停留风险、画面叠加、MJPEG 和 JSONL 事件。

## 构建与模型

```powershell
& platforms/rk3566/model.ps1 -Action All `
  -SourceModel models/yolo11n-pose.pt `
  -SourceVideo "C:\Users\31919\Videos\NVIDIA\Desktop\Desktop 2026.08.29 - 18.49.55.01.mp4"

& platforms/rk3566/build.ps1 -Target All
```

模型转换和正式交叉编译默认使用 Docker Desktop。输出为：

- `platforms/rk3566/artifacts/model/poseguard-yolo11n-pose-320-int8.rknn`
- `build/rk3566-aarch64/poseguard-rk3566`

## 部署与运行

```powershell
& platforms/rk3566/deploy.ps1
```

脚本默认部署到 `root@192.168.31.230`，核对每个文件的 SHA-256，保留一份上一版本并安装 `/etc/init.d/S99poseguard`。不会替换板上的 `librknnrt.so`。

本地视频 120 帧测试：

```sh
/userdata/poseguard/bin/poseguard-rk3566 \
  --config /userdata/poseguard/config/poseguard.conf \
  --source video \
  --video /userdata/poseguard/media/yoga-regression.mp4 \
  --benchmark --max-frames 120 --no-http
```

USB 摄像头模式不固定 `/dev/videoN`。程序从 sysfs 找 `uvcvideo`，排除 RKISP、raw 和 metadata 节点，再用 `VIDIOC_QUERYCAP` 验证。优先 `MJPEG 640×480@30`；摄像头未接入或重新插拔时进程保持运行并每 2 秒重扫。

网页接口：

- `http://<板子IP>:8081/`
- `http://<板子IP>:8081/stream.mjpg`
- `http://<板子IP>:8081/status.json`

事件只在 candidate、alert、clear 状态变化时写入 `/userdata/poseguard/runs/events.jsonl`，不保存图像、原视频或完整关键点。

## 服务管理

```sh
/etc/init.d/S99poseguard start
/etc/init.d/S99poseguard stop
/etc/init.d/S99poseguard restart
/etc/init.d/S99poseguard status
tail -f /userdata/poseguard/logs/poseguard.log
```

默认配置见 `config/poseguard.conf`。没有 USB 摄像头时，服务状态仍为 running，网页显示 `WAITING FOR USB CAMERA`。
