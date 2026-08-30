# PoseGuard RK3566 验证记录

日期：2026-08-30

## 已完成的本机验证

- Windows 项目测试：164 passed。
- RK3566 C++ 测试：5/5 passed，覆盖基础类型、三类风险、17 点解码、UVC 节点选择、叠加与 JSONL 状态变化。
- YOLO11n-Pose ONNX：静态输入 320×320，输出 `[1,56,2100]`，并在 3 张留出帧中均检测到人体。
- 校准输入：从 631 帧瑜伽视频均匀抽取 40 张；另留 3 张做量化前后比较。
- 回归视频：960×540、30 FPS、H.264、yuv420p。
- 完整板端代码（RKNN、GStreamer、V4L2、JPEG、HTTP）已用 AArch64 工具链编译并动态链接，ELF machine 为 183。
- UVC 实现不依赖固定 `/dev/video9`，主机夹具验证会排除 RKISP 和 metadata 节点。

## 待板端恢复在线后执行

当前 `192.168.31.230:22` 连接超时，因此以下数据不伪造，待设备在线后补录：

- INT8 RKNN 文件 SHA-256；
- 板端 RKNN Runtime 与驱动实际版本；
- 模型一次加载与 17 点输出；
- 本地视频 30 帧输入冒烟；
- 120 帧 FPS、平均推理耗时和峰值 RSS；
- 完整瑜伽视频回放、MJPEG、JSONL；
- 安装服务后的一次真实重启验证；
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
