# PoseGuard 人体风险姿态预警原型

PoseGuard 是一个本地运行的多人姿态跟踪与疑似风险行为辅助预警程序。第一阶段仅识别三类行为：多人进入监控区、疑似持手机贴耳通话、长时间停留。红色框只表示需要人工关注，不代表身份、违法事实或诈骗结论。

## Windows 运行

```powershell
cd C:\Users\31919\Desktop\poseguard\.worktrees\human-risk-pose
python -m pip install -r requirements.txt
python -m poseguard.app --source 0 --config configs/windows.json
```

检查摄像头和运行环境：

```powershell
python scripts/check_windows.py --source 0
```

无窗口定量测试（处理 120 帧后自动退出）：

```powershell
python -m poseguard.app --source 0 --config configs/windows.json --no-display --max-frames 120
```

当前 Windows CPU 环境的实测过程、结果与尚未验证的边界见 `docs/windows-validation.md`。

如果检查结果显示 `CUDA available: False`，当前 PyTorch 是 CPU 构建，程序仍可运行，但实时帧率会明显低于 NVIDIA CUDA 构建；后续可在确认驱动与 CUDA 版本后单独替换 PyTorch。

视频文件测试：

```powershell
python -m poseguard.app --source C:\path\to\test.mp4 --config configs/windows.json
```

按 `p` 暂停/继续，按 `q` 或 ESC 退出。默认事件写入 `runs/events.jsonl`，不保存原始视频、图片、人脸或完整关键点。

## 模型文件

Windows 原型默认读取：

- `models/yolo11n-pose.pt`：人体框与 17 个 COCO 关键点；
- `models/yolo11n.pt`：仅在出现贴耳候选姿态时检测 COCO `cell phone` 类别。

可以使用 `--disable-phone` 禁用手机实物检测；此时贴耳姿态只保持橙色候选，不升级为确认红色。

## 原创模块边界

模型只输出框、关键点和手机候选。稳定 ID、短时漏检保持、尺度归一化几何、时间窗口、滞回解除、风险融合、事件格式和界面由本工程独立实现。模型后端有明确接口，可替换为 RKNN、MaixPy/MaixCDK 或其他具备合适授权的运行时。

## 许可证提示

本工程不会把第三方代码或模型权重声明为原创。Ultralytics 提供 AGPL-3.0 与企业授权方案；闭源商业发布前必须结合最终模型权重、运行库和分发方式复核许可证。详见 `LICENSES.md`。

## 嵌入式目标

后期提供三个互不依赖的端侧版本，每个设备都独立完成摄像头采集、人体姿态推理、多人轨迹、风险判断和告警：

- 泰山派 RK3566 使用 USB 摄像头，并以 RKNN INT8 作为板端推理目标；
- MaixCAM Pro 使用板载摄像头和 MaixPy/MaixCDK 兼容模型；
- XIAO ESP32-S3 Sense 使用板载 OV3660，并运行单独蒸馏、剪枝和 INT8 量化的 TinyML 姿态模型，不作为其他设备的采集前端。

三端共享风险类型、状态颜色和事件语义，但不强求使用同一个模型文件。具体边界见 `docs/embedded-portability.md`。

## MaixCAM Pro 运行

MaixCAM 版本直接使用板载摄像头、屏幕和 `/root/models/yolo11n_pose.mud`。从 Windows 部署：

```powershell
& platforms/maixcam/deploy.ps1
```

板上仅有约 128MB Linux 可见内存。通过 SSH 手动测试前，应先退出 Launcher 及其守护进程，避免与姿态模型同时占用多媒体内存：

```sh
killall launcher_daemon launcher 2>/dev/null || true
cd /root/poseguard_maix
python main.py --max-frames 300
```

现场快速测试风险计时：

```sh
python main.py --test-timers
```

测试结束后重启板子即可恢复原 Launcher。Maix 事件默认写入 `/root/poseguard_maix/data/events.jsonl`，不保存原始图像。

## 泰山派 RK3566 运行

泰山派版本使用 USB 摄像头、RKNN INT8 与板端 GStreamer/MPP，独立完成人体姿态推理、稳定 ID、三类风险和网页告警。构建、部署、开机启动及摄像头热插拔说明见 `platforms/rk3566/README.md`。

```powershell
& platforms/rk3566/build.ps1 -Target All
& platforms/rk3566/deploy.ps1
```

默认网页为 `http://192.168.31.230:8081/`。没有 USB 摄像头时服务不会退出，而是保持开机运行并等待设备接入。
