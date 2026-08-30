# 泰山派 RK3566 PoseGuard 独立端移植设计

## 1. 目标

在立创·泰山派 RK3566 的 Buildroot 系统上实现一套不依赖 Windows、MaixCAM 或云端推理服务的 PoseGuard 版本。设备本机完成视频采集、YOLO11n-Pose INT8 推理、17 点姿态解码、多人轨迹、风险判断、画面叠加、MJPEG 网页和 JSONL 事件记录。

首轮先用本地瑜伽视频验证完整链路，同时交付 USB UVC 摄像头输入和 Buildroot 开机启动。当前 USB 摄像头未连接时，服务必须保持运行并等待设备，不得反复退出；摄像头接入后自动识别、打开并恢复推理。

本版只判断三类风险：

1. 监控区域内多人持续出现；
2. 单手靠近同侧耳部且人体近似站立的疑似通话姿态；
3. 人员在区域内低活动停留超过阈值。

贴耳判断首版只使用姿态证据，不增加手机目标检测模型。普通活动、瑜伽动作和短时漏检不应直接触发红色告警。

## 2. 已验证的目标环境

当前测试板已通过 SSH 实机检查：

- SoC：RK3566，4 核 AArch64；
- 系统：Buildroot 2024.02，Linux 6.1.141，glibc 2.41；
- 内存：约 2 GB，无 swap；
- 持久数据分区：`/userdata`，可用空间约 2.2 GB；
- RKNN Runtime：2.3.2；
- RKNPU 驱动：0.9.8；
- 官方 MobileNet INT8 冒烟模型：单次推理约 10.5 ms；
- GStreamer：1.24.13；
- 可用插件：`qtdemux`、`decodebin`、`h264parse`、`mppvideodec`、`videoconvert`、`videoscale`、`appsrc`、`appsink`、`jpegenc`、`mppjpegenc`、`mpph264enc`；
- 可用库：RKNN Runtime、RGA、MPP、GStreamer、libjpeg、TurboJPEG；
- 系统没有 Python、pip、OpenCV、gcc 或 g++，因此不在板端安装 Python 推理栈。

Windows 主机的 Docker Desktop 已安装但守护进程当前未启动。模型转换与 ARM64 交叉编译均在 Docker Linux 容器内完成。

## 3. 路线比较与选择

### 方案 A：C++ RKNN Runtime + GStreamer（采用）

在 Docker 中完成 ONNX/RKNN 转换和 AArch64 C++17 交叉编译，板端直接调用现有 `librknnrt.so`，使用 GStreamer/MPP 解码和 JPEG 编码。该方案不修改系统镜像，运行体积小，启动快，并与当前 Buildroot 能力完全匹配。

### 方案 B：打包 Python + RKNN Lite2 + NumPy/OpenCV

能够较多复用 Windows Python 代码，但需要额外打包解释器和大型二进制依赖，容易出现 glibc、Python ABI 和 OpenCV 编解码兼容问题，不适合当前最小 Buildroot 镜像。

### 方案 C：重新编译并刷入包含 Python 的 Buildroot

运行环境最整齐，但需要完整 SDK、长时间系统编译和重新刷机，扩大了本轮移植范围，也增加现有网络和系统配置丢失风险。

采用方案 A。业务语义按现有 Python 版等价重写为 C++，不逐行翻译文件结构。

## 4. 模型转换设计

输入模型为仓库现有 `models/yolo11n-pose.pt`。目标流程如下：

```text
YOLO11n-Pose PyTorch
  -> 固定 320x320 ONNX
  -> 图结构检查与必要简化
  -> RKNN-Toolkit2 2.3.2 INT8
  -> poseguard-yolo11n-pose-320-int8.rknn
```

ONNX 使用静态 batch 1 和静态输入尺寸。NMS、17 点解码、坐标还原和质量过滤放在 C++ 后处理，不依赖模型内自定义后处理算子。量化校准帧从人体姿态视频中按时间均匀抽取，避免只用纯背景或单一姿态。

转换后分别在 ONNX 和 RKNN 上运行同一批帧，比较人体置信度、框坐标和 17 点坐标。比较采用容差，不要求 INT8 与 FP32 逐位一致。

如果转换失败，依次尝试静态导出、受支持 ONNX opset、图简化以及把更多后处理移出模型。必要时对少量量化敏感层采用混合量化。只有明确记录不兼容算子且 YOLO11n-Pose 路线仍不可运行时，才向用户报告并讨论备用姿态模型，不静默更换模型。

## 5. 板端架构

```text
本地 MP4 或 USB UVC
          |
          v
GStreamer/MPP 输入适配器
          |
          v
RGB 最新帧 + PTS/单调时间
          |
          v
320x320 Letterbox -> RKNN NPU -> YOLO11n-Pose 解码
          |
          v
观测质量过滤 -> 稳定轨迹 -> 风险规则
          |
          v
黄/橙/红框、骨架和状态叠加
          |
          +--> MPP JPEG 每帧编码一次 -> 最新 JPEG 缓存 -> MJPEG HTTP
          |
          +--> 风险状态变化 -> JSONL
```

### 5.1 组件边界

- `GstVideoSource`：本地 MP4 解封装、MPP 硬解、PTS 提取和实时节奏控制；
- `UvcCameraSource`：USB 摄像头发现、格式协商、最新帧采集、断开重连；
- `RknnPoseEngine`：模型加载、输入预处理、RKNN 推理、输出反量化和 17 点解码；
- `ObservationFilter`：过滤低关键点证据、异常面积、边缘杂物和高度重叠的重复人体；
- `TrackManager`：稳定单调 ID、指数平滑、短时丢失保持、路径长度和姿态运动量；
- `RiskEngine`：多人、姿态式贴耳、低活动停留及告警滞回；
- `OverlayPainter`：骨架、边框、ID、状态和性能指标；
- `JpegPublisher`：每个处理帧只编码一次，所有客户端共享最新 JPEG；
- `HttpServer`：提供监控主页、MJPEG 流和轻量状态 JSON；
- `EventWriter`：仅在状态变化时追加 JSONL；
- `Application`：配置、线程、信号和资源生命周期。

### 5.2 核心数据结构

`PoseObservation` 保存人体框、人体置信度和固定 17 个关键点。每个关键点包含 `x`、`y`、`confidence` 和 `valid`。

`TrackState` 保存稳定 ID、平滑后框和姿态、首次与最近出现时间、缺失帧数、预测标志、累计路径以及归一化姿态运动量。

`RiskDecision` 保存目标 ID、风险种类、`normal/candidate/alert` 状态、原因、持续时间和用于绘制的框。

固定长度数组和有上限的轨迹容器用于避免长时间运行中无界增长。首版最大同时跟踪人数为 8，可在配置中降低。

## 6. 输入设计

### 6.1 本地视频

本地回放默认采用视频 PTS 驱动风险计时，使同一视频重复运行时触发时间一致。提供两种模式：

- `realtime`：按视频时间播放，用于观察动态告警；
- `benchmark`：不等待原始帧率，用于测量板端最大处理能力。

本轮固定使用最近录制的人体瑜伽测试素材：

`C:\Users\31919\Videos\NVIDIA\Desktop\Desktop 2026.08.29 - 18.49.55.01.mp4`

该文件为 2560×1440、约 60 FPS、约 10.5 秒的桌面录屏，画面中包含正在播放的瑜伽动作和现有 Windows PoseGuard 输出。部署前通过 Docker 生成聚焦人体区域、适合板端解码的 `yoga-regression.mp4`，并复制到 `/userdata/poseguard/media/`。原文件保持不变。

### 6.2 USB UVC 摄像头

不能固定使用 `/dev/video9` 或 `/dev/video10`。RK3566 本身已有多个 ISP 视频节点，USB 设备号还会随插拔变化。自动发现流程读取 `/sys/class/video4linux/video*/name` 和设备父级总线，只选择 USB UVC 的可采集节点；命令行仍允许显式指定设备路径。

首选协商 MJPEG 640×480@30 FPS，再按设备能力回退到 MJPEG 1280×720、YUYV 640×480 或其他实际支持组合。默认使用低延迟配置：

- GStreamer 下游泄漏队列只留一帧；
- `appsink max-buffers=1 drop=true sync=false`；
- 主推理永远消费最新帧；
- 不因网页客户端速度造成摄像头帧堆积。

摄像头未连接时，程序保持 HTTP 状态页和占位画面，并按退避间隔重新扫描。运行中拔出设备时关闭失效管线、清除旧帧并返回等待状态；重新插入后恢复采集，不重启主进程。

## 7. 跟踪与风险语义

观测至少包含足够可见关键点和躯干证据才进入轨迹。高度重叠且关键点结构相近的观测只保留质量更高者。新轨迹连续匹配若干帧后才发布；短时漏检使用上一状态保持 ID，但预测帧不新增风险证据。

贴耳候选要求同侧腕、肘、肩、耳关键点有效，腕耳距离满足人体尺度阈值，前臂结构合理，并且肩髋和腿部证据表明人体近似站立。候选持续达到阈值后升级为红色告警，证据消失后按释放时间解除。

多人风险只统计确认且位于监控区域内的可见轨迹。低活动停留同时要求框中心速度和姿态运动量较低；明显瑜伽、挥手或原地肢体运动会重置当前低活动计时。

正常使用黄色，候选使用橙色，确认风险使用红色。同一目标的多个风险原因可以同时存在，但事件按目标与风险种类分别记录。

## 8. MJPEG 与事件输出

HTTP 默认监听局域网 `0.0.0.0:8081`：

- `/`：简洁监控页面；
- `/stream.mjpg`：处理后 MJPEG；
- `/status.json`：帧数、FPS、推理时间、人数、告警数、输入状态和最近错误。

叠加后的 RGB 帧通过 `mppjpegenc` 或可用 JPEG 编码器只编码一次，编码结果覆盖最新 JPEG 缓存。每个客户端线程只发送缓存字节，不重复编码整帧，也不积压旧帧。

事件文件位于 `/userdata/poseguard/runs/events.jsonl`。只记录时间、视频 PTS、目标 ID、风险类型、状态、持续时间、框和性能摘要，不保存原始帧或人员身份信息。

## 9. 配置与命令行

使用轻量 `key=value` 配置，避免在 Buildroot 上增加大型配置解析依赖。配置包括：

- 模型、输入类型、本地视频、UVC 匹配名称和显式设备路径；
- 摄像头格式、分辨率、帧率和重连间隔；
- 置信度、关键点、重复框和轨迹阈值；
- 三类风险的触发、释放和监控区域参数；
- HTTP 地址、端口、JPEG 质量和事件路径；
- `realtime/benchmark` 模式及性能日志周期。

命令行参数覆盖配置文件，至少支持 `--config`、`--source video|camera`、`--video`、`--device`、`--benchmark`、`--max-frames` 和 `--no-http`。

## 10. 部署与开机启动

部署目录固定为：

```text
/userdata/poseguard/
├── bin/poseguard-rk3566
├── models/poseguard-yolo11n-pose-320-int8.rknn
├── config/poseguard.conf
├── media/yoga-regression.mp4
├── runs/events.jsonl
├── logs/poseguard.log
└── backup/
```

Windows 部署脚本使用 SSH/SCP：先上传到临时名称，校验文件大小和哈希，通过后再原子替换；更新二进制、模型和配置前分别保留一份上一版本。部署不覆盖系统自带 `librknnrt.so`。

开机脚本安装为 `/etc/init.d/S99poseguard`，使用 Buildroot 的 `start-stop-daemon` 管理 PID，默认以 `camera` 输入启动。启动时没有 USB 摄像头不视为服务失败，程序继续提供状态页并等待摄像头。脚本提供 `start`、`stop`、`restart` 和 `status`，日志写入 `/userdata`，避免写满临时根目录。

本地视频验收时先停止开机服务，使用显式 `--source video` 运行；验收完成后恢复摄像头服务。首次安装开机脚本后执行一次重启验证，确认系统启动、服务状态、无摄像头等待和网络页面均正常。若启动异常，停止服务并恢复上一版文件，不阻断 SSH 登录。

## 11. 异常处理

- RKNN 模型、Runtime 版本、输入输出数量或量化参数不符合预期时拒绝启动推理；
- 视频文件不存在、格式不支持或解码中断时输出明确原因并安全退出该次视频任务；
- UVC 未连接或断开时进入等待与重连，不退出开机服务；
- 连续异常推理结果不进入轨迹和风险模块；
- HTTP 客户端断开只结束对应连接；
- 事件文件写入失败时保留推理和网页功能，并在状态接口报告错误；
- 收到 `SIGINT` 或 `SIGTERM` 后停止输入、HTTP、编码和 RKNN，刷新日志并释放资源；
- 所有帧队列、轨迹、事件摘要和客户端数量均设置上限。

## 12. 最小测试与验收

### 12.1 主机测试

- C++ 规则测试复用现有合成姿态向量，验证多人、贴耳、停留、运动重置和告警解除；
- 输入发现测试使用模拟 sysfs 条目，确保不会把 RKISP 节点误认成 USB 摄像头；
- HTTP 与事件序列化测试不依赖 RKNN 或真实视频；
- ONNX 与 RKNN 使用同一批校准外样本比较人体框和关键点误差。

### 12.2 板端测试

1. 使用官方 RKNN 环境确认新模型加载和一次推理成功；
2. 运行本地瑜伽视频固定帧数冒烟测试；
3. 完整回放 `yoga-regression.mp4`，验证文件结束时退出码为 0；
4. 实时模式打开 MJPEG，检查骨架、稳定 ID和黄/橙/红状态；
5. 验证 JSONL 可逐行解析且未生成原始截图；
6. 记录模型、后处理、总帧率、峰值 RSS 和 NPU/CPU 温度；
7. 启用开机服务并重启，验证无摄像头时服务保持等待且网页可访问；
8. USB 摄像头接入后验证自动识别、格式协商、低延迟采集、拔出等待和重新插入恢复。

当前未连接 USB 摄像头，因此第 8 项代码和部署包含在本轮，实机热插拔验收在硬件接入后立即执行；其他项目不因此省略。

## 13. 完成标准

以下条件满足后，RK3566 首版移植完成：

1. YOLO11n-Pose 320 INT8 RKNN 可由板端 Runtime 2.3.2 加载并输出有效 17 点姿态；
2. 本地瑜伽视频从开始处理到文件结束，无崩溃、无无界内存增长；
3. 网页能显示最新处理帧、稳定 ID、骨架和风险颜色；
4. 三类风险与现有业务语义一致，瑜伽明显运动不会继承低活动停留计时；
5. 事件 JSONL 格式有效且不保存原始图像；
6. 开机服务可启动、停止、查询，摄像头缺席时保持等待；
7. USB UVC 适配不依赖固定 `/dev/videoN`，硬件接入后能够完成热插拔验收；
8. 部署脚本能校验上传结果并保留上一版本；
9. 实测 FPS、分项耗时、内存和温度写入运行报告。
