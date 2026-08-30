# PoseGuard TaishanPi RK3566 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在泰山派 RK3566 Buildroot 上尽快跑通独立的 PoseGuard 闭环：本地视频或 USB 摄像头、YOLO11n-Pose 320×320 INT8 RKNN、人体轨迹、三类风险、MJPEG、JSONL 和开机启动。

**Architecture:** `platforms/rk3566` 使用 C++17，纯业务核心与 RKNN/GStreamer 板端适配分开。模型转换和 AArch64 编译在 Docker 完成，板端只运行单个二进制并复用现有 RKNN Runtime 2.3.2。首版坚持 YAGNI：不加入手机检测、数据库、复杂插件系统或压力测试，只做足以发现模型格式、风险逻辑、输入和启动故障的最小验证。

**Tech Stack:** C++17, CMake, RKNN Runtime/Toolkit2 2.3.2, GStreamer 1.24, Rockchip MPP, POSIX sockets, Docker Desktop, PowerShell, Buildroot init script.

---

## 精简后的验证范围

只保留以下检查：

1. 一个 C++ 核心测试程序覆盖贴耳、多人、停留、运动重置和短时漏检；
2. 一个 Python 工具测试检查模型输入输出契约和校准帧采样；
3. 一个 C++ 解码测试检查 56 通道、17 点和 letterbox 还原；
4. 一个 UVC 发现测试确保不会选到 RKISP 节点；
5. 板端模型加载、30 帧输入和 120 帧完整流水线冒烟；
6. 一次本地视频完整回放和一次真实开机启动验证。

不做 Valgrind、配置参数穷举、HTTP 并发压力、重复的逐模块单测、模拟开机系统或多轮回归矩阵。USB 摄像头当前未连接，代码本轮完成，真实热插拔只在硬件接入后验证。

## 文件地图

```text
platforms/rk3566/
├── CMakeLists.txt
├── build.ps1
├── model.ps1
├── config/poseguard.conf
├── docker/model.Dockerfile
├── docker/toolchain.Dockerfile
├── include/poseguard/
│   ├── types.hpp
│   ├── core.hpp
│   ├── rknn_pose.hpp
│   ├── video_source.hpp
│   └── runtime.hpp
├── src/
│   ├── core.cpp
│   ├── rknn_pose.cpp
│   ├── video_source.cpp
│   ├── runtime.cpp
│   └── main.cpp
├── tests/
│   ├── test_main.cpp
│   ├── test_core.cpp
│   ├── test_decoder.cpp
│   └── test_uvc.cpp
├── tools/
│   ├── export_pose_onnx.py
│   ├── prepare_inputs.py
│   ├── convert_pose_rknn.py
│   └── compare_outputs.py
├── deploy.ps1
└── service/S99poseguard
```

`core.cpp` 集中承载首版规模可控的过滤、轨迹和风险逻辑；`runtime.cpp` 集中承载绘制、JSONL、JPEG、HTTP 和应用循环，避免为了形式拆出大量小文件。

### Task 1: 建立 Docker/CMake 骨架与基础类型

**Files:**
- Modify: `.gitignore`
- Create: `platforms/rk3566/CMakeLists.txt`
- Create: `platforms/rk3566/docker/toolchain.Dockerfile`
- Create: `platforms/rk3566/build.ps1`
- Create: `platforms/rk3566/include/poseguard/types.hpp`
- Create: `platforms/rk3566/src/main.cpp`
- Create: `platforms/rk3566/tests/test_main.cpp`

- [ ] **Step 1: 写一个最小失败测试**

`test_main.cpp` 自带简单 `CHECK` 宏，不引入测试框架：

```cpp
#include "poseguard/types.hpp"
#include <cstdlib>
#include <iostream>

#define CHECK(expr) do { if (!(expr)) { std::cerr << #expr << '\n'; return 1; } } while (0)

int main() {
  poseguard::PoseObservation person{};
  CHECK(person.keypoints.size() == 17);
  CHECK(poseguard::color_for(poseguard::RiskState::Normal) ==
        (poseguard::Rgb{255, 220, 0}));
  CHECK(poseguard::color_for(poseguard::RiskState::Alert) ==
        (poseguard::Rgb{255, 0, 0}));
  std::cout << "core-types-ok\n";
  return 0;
}
```

- [ ] **Step 2: 建立测试镜像并验证 RED**

`toolchain.Dockerfile` 基于 Debian 12：`native-test` 安装 `g++ cmake ninja-build`；`aarch64-build` 安装 `g++-aarch64-linux-gnu`、ARM64 GStreamer/TurboJPEG 开发包，并从 Rockchip 官方 `v2.3.2` 取得 `rknn_api.h` 与仅用于链接的 AArch64 `librknnrt.so`。

Run:

```powershell
docker build -f platforms/rk3566/docker/toolchain.Dockerfile --target native-test -t poseguard-rk3566-test .
docker run --rm -v "${PWD}:/workspace" -w /workspace poseguard-rk3566-test `
  cmake -S platforms/rk3566 -B build/rk3566-native -DPOSEGUARD_BUILD_TESTS=ON -DPOSEGUARD_ENABLE_BOARD=OFF
docker run --rm -v "${PWD}:/workspace" -w /workspace poseguard-rk3566-test `
  cmake --build build/rk3566-native -j2
```

Expected: 因 `types.hpp` 的类型尚未实现而编译失败。

- [ ] **Step 3: 实现基础类型和最小程序入口**

`types.hpp` 定义 C++17 类型：

```cpp
namespace poseguard {
constexpr std::size_t kKeypointCount = 17;
constexpr std::size_t kMaxTracks = 8;

struct Rgb {
  std::uint8_t r{}, g{}, b{};
  bool operator==(const Rgb& rhs) const {
    return r == rhs.r && g == rhs.g && b == rhs.b;
  }
};
struct Point { float x{}, y{}; };
struct BBox { float x1{}, y1{}, x2{}, y2{}; };
struct Keypoint { float x{}, y{}, confidence{}; bool valid{}; };
struct PoseObservation {
  int detection_index{};
  BBox bbox{};
  float confidence{};
  std::array<Keypoint, kKeypointCount> keypoints{};
};
enum class RiskKind { None, PhoneToEar, MultiPerson, Lingering };
enum class RiskState { Normal, Candidate, Alert };
Rgb color_for(RiskState state);
}
```

同文件定义 `TrackState`、`RiskDecision`、`Frame` 和 `Metrics`。`main.cpp` 先支持 `--version` 并返回 0。

- [ ] **Step 4: 实现构建脚本并验证 GREEN**

`build.ps1 -Target Test|Aarch64|All` 负责 Docker 构建和 CMake 命令；Docker 未启动时只输出启动 Docker Desktop 的提示并返回非零。

Run:

```powershell
& platforms/rk3566/build.ps1 -Target Test
& platforms/rk3566/build.ps1 -Target Aarch64
```

Expected: `core-types-ok`；AArch64 产物经 `file` 显示为 ARM64 ELF。

- [ ] **Step 5: 忽略生成物并提交**

`.gitignore` 增加：

```gitignore
build/rk3566-*/
platforms/rk3566/artifacts/
platforms/rk3566/media/*.mp4
models/*.onnx
models/*.rknn
```

```bash
git add .gitignore platforms/rk3566
git commit -m "build: scaffold RK3566 runtime"
```

### Task 2: 一次性实现过滤、轨迹和三类风险

**Files:**
- Create: `platforms/rk3566/include/poseguard/core.hpp`
- Create: `platforms/rk3566/src/core.cpp`
- Create: `platforms/rk3566/tests/test_core.cpp`
- Modify: `platforms/rk3566/CMakeLists.txt`

- [ ] **Step 1: 写五个核心场景测试**

`test_core.cpp` 复用一个合成人体工厂，只覆盖首版必须行为：

```cpp
CHECK(phone_pose_at(0.0).state == RiskState::Candidate);
CHECK(phone_pose_at(1.1).state == RiskState::Alert);
CHECK(two_people_at(0.0).state == RiskState::Candidate);
CHECK(two_people_at(1.6).state == RiskState::Alert);
CHECK(still_person_at(20.1).state == RiskState::Alert);
CHECK(moving_yoga_pose_resets_lingering());
CHECK(short_dropout_keeps_same_track_id());
```

贴耳测试必须有同侧耳、肩、肘、腕、髋和踝；不提供手机框。

- [ ] **Step 2: 运行并验证 RED**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: `core.hpp` 或核心接口缺失。

- [ ] **Step 3: 实现最小业务核心**

接口固定为：

```cpp
class PoseCore {
 public:
  explicit PoseCore(CoreConfig config);
  std::vector<TrackState> update_tracks(
      const std::vector<PoseObservation>& observations, double timestamp);
  std::vector<RiskDecision> evaluate(
      const std::vector<TrackState>& tracks, int width, int height, double timestamp);
 private:
  std::array<std::optional<TrackState>, kMaxTracks> tracks_{};
};
```

只实现以下规则：

- 观测至少 6 个有效点、3 个躯干点，框面积占画面 `0.015–0.75`；
- 重复观测需 IoU ≥ `0.45` 且平均共享关键点距离 ≤ 身体尺度 `0.05`，保留分数高者；
- 轨迹用中心距离、面积比和共享关键点距离贪心匹配，最大代价 `1.15`，平滑系数 `0.55`，连续 3 帧确认，最多 8 人，漏检保留 1.5 秒；
- 贴耳：近似站立、同侧腕耳距离 ≤ 框高 `0.13`，持续 1 秒后红色；
- 多人：区域内至少 2 个可见确认轨迹，持续 1.5 秒后红色；
- 停留：区域内中心速度/框高 ≤ `0.12/s` 且姿态运动 ≤ `0.04`，持续 20 秒后红色；
- 预测帧不新增风险证据，红色释放时间 `0.8` 秒。

姿态运动量取共享关键点位移中最大四分之一的归一化平均值；明显瑜伽动作立即重置停留计时。

- [ ] **Step 4: 运行核心测试并提交**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: 所有核心场景通过。

```bash
git add platforms/rk3566
git commit -m "feat: add RK3566 tracking and risk core"
```

### Task 3: 导出并量化 YOLO11n-Pose

**Files:**
- Create: `platforms/rk3566/docker/model.Dockerfile`
- Create: `platforms/rk3566/tools/export_pose_onnx.py`
- Create: `platforms/rk3566/tools/prepare_inputs.py`
- Create: `platforms/rk3566/tools/convert_pose_rknn.py`
- Create: `platforms/rk3566/tools/compare_outputs.py`
- Create: `platforms/rk3566/model.ps1`
- Create: `tests/rk3566/test_model_tools.py`

- [ ] **Step 1: 写一个模型工具测试**

```python
def test_sampling_and_pose_contract():
    assert sample_indices(631, 5) == [0, 157, 315, 472, 630]
    assert normalize_output_shape([1, 56, 2100]) == {
        "layout": "BCN", "channels": 56, "anchors": 2100, "keypoints": 17
    }
```

- [ ] **Step 2: 运行并验证 RED**

Run: `python -m pytest tests/rk3566/test_model_tools.py -q`

Expected: 工具模块不存在。

- [ ] **Step 3: 实现固定版本模型容器和导出**

`model.Dockerfile` 使用 Python 3.10，固定 Rockchip `rknn-toolkit2 v2.3.2` 官方 CP310 wheel、对应 requirements 和 `ultralytics==8.4.103`。

`export_pose_onnx.py` 执行：

```python
model.export(format="onnx", imgsz=320, batch=1, dynamic=False,
             simplify=True, opset=12, nms=False)
```

脚本只接受一个 56 通道输出：`4 bbox + 1 person + 17*3 keypoints`；支持 BCN/BNC 两种布局，其他形状直接退出并打印实际 shape。

- [ ] **Step 4: 准备 40 张校准帧和测试视频**

从：

```text
C:\Users\31919\Videos\NVIDIA\Desktop\Desktop 2026.08.29 - 18.49.55.01.mp4
```

均匀抽取 40 帧。容器内 ffmpeg 生成 `platforms/rk3566/media/yoga-regression.mp4`：

```text
crop=960:540:210:215,fps=30,scale=960:540
H.264, yuv420p, faststart
```

- [ ] **Step 5: 转换 INT8 并做最小一致性比较**

`convert_pose_rknn.py` 使用：

```python
rknn.config(target_platform="rk3566", mean_values=[[0, 0, 0]],
            std_values=[[255, 255, 255]], optimization_level=3)
rknn.load_onnx(model=onnx_path)
rknn.build(do_quantization=True, dataset=dataset_txt)
rknn.export_rknn(output_path)
```

只比较 3 张未参与校准的帧：人数一致，最高分人体框 IoU ≥ `0.70`，有效关键点平均误差 ≤ 人体高度 `0.07`。达不到时保留报告并调整量化，不换模型。

Run:

```powershell
python -m pytest tests/rk3566/test_model_tools.py -q
& platforms/rk3566/model.ps1 -Action All `
  -SourceModel models/yolo11n-pose.pt `
  -SourceVideo "C:\Users\31919\Videos\NVIDIA\Desktop\Desktop 2026.08.29 - 18.49.55.01.mp4"
```

Expected: 生成 `artifacts/model/poseguard-yolo11n-pose-320-int8.rknn`、40 张校准图、3 帧比较报告和 960×540 测试视频。

- [ ] **Step 6: 提交工具**

```bash
git add platforms/rk3566/docker/model.Dockerfile platforms/rk3566/tools \
  platforms/rk3566/model.ps1 tests/rk3566
git commit -m "build: convert pose model for RK3566"
```

### Task 4: 实现 RKNN 推理和 17 点解码

**Files:**
- Create: `platforms/rk3566/include/poseguard/rknn_pose.hpp`
- Create: `platforms/rk3566/src/rknn_pose.cpp`
- Create: `platforms/rk3566/tests/test_decoder.cpp`
- Modify: `platforms/rk3566/src/main.cpp`
- Modify: `platforms/rk3566/CMakeLists.txt`

- [ ] **Step 1: 写一个合成张量解码测试**

```cpp
auto output = fixture_single_person_56x2100();
Letterbox tx{0.5F, 0, 40, 640, 480};
auto people = decode_pose(output, {1, 56, 2100}, tx, 0.35F, 0.25F, 0.45F);
CHECK(people.size() == 1);
CHECK(people[0].keypoints.size() == 17);
CHECK(std::abs(people[0].bbox.x1 - 240.0F) < 1.0F);
```

- [ ] **Step 2: 运行并验证 RED**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: `decode_pose` 未定义。

- [ ] **Step 3: 实现 letterbox、反量化和解码**

`RknnPoseEngine` 执行模型读取、`rknn_init`、张量查询、320×320 RGB letterbox、推理、输出反量化和解码。INT8 使用 `(value - zero_point) * scale`；输出转换为 `[cx,cy,w,h,score,17*(x,y,confidence)]`，再还原到源画面并做单类 NMS。

构造阶段仅检查关键条件：Runtime 可初始化、1 个 RGB 输入、320×320、输出含 56 通道。错误时打印实际属性并退出。

`main.cpp` 增加：

```text
--model-smoke <model.rknn>
```

该入口用一张灰色 320×320 RGB 帧运行一次并打印 Runtime、驱动、张量形状和耗时。

- [ ] **Step 4: 主机测试、交叉编译和板端模型冒烟**

Run:

```powershell
& platforms/rk3566/build.ps1 -Target All
scp -i "$env:USERPROFILE\.ssh\id_ed25519" `
  platforms/rk3566/artifacts/model/poseguard-yolo11n-pose-320-int8.rknn `
  root@192.168.31.230:/userdata/poseguard-smoke.rknn
scp -i "$env:USERPROFILE\.ssh\id_ed25519" `
  build/rk3566-aarch64/poseguard-rk3566 `
  root@192.168.31.230:/userdata/poseguard-smoke
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" root@192.168.31.230 `
  "chmod +x /userdata/poseguard-smoke && /userdata/poseguard-smoke --model-smoke /userdata/poseguard-smoke.rknn"
```

Expected: C++ 解码测试通过；板端显示 RKNN Runtime 2.3.2、驱动 0.9.8，并完成一次推理，退出码 0。

- [ ] **Step 5: 提交**

```bash
git add platforms/rk3566
git commit -m "feat: run RKNN pose inference"
```

### Task 5: 实现本地视频和 USB 摄像头输入

**Files:**
- Create: `platforms/rk3566/include/poseguard/video_source.hpp`
- Create: `platforms/rk3566/src/video_source.cpp`
- Create: `platforms/rk3566/tests/test_uvc.cpp`
- Modify: `platforms/rk3566/src/main.cpp`
- Modify: `platforms/rk3566/CMakeLists.txt`

- [ ] **Step 1: 写一个 UVC 发现测试**

用临时 sysfs 夹具同时放入 `rkisp_mainpath` 和 `USB Camera`，注入假的 `VIDIOC_QUERYCAP`：

```cpp
auto devices = discover_uvc_devices(sysfs_root, fake_capability_probe);
CHECK(devices.size() == 1);
CHECK(devices[0].path == "/dev/video9");
```

- [ ] **Step 2: 运行并验证 RED**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: UVC 发现接口缺失。

- [ ] **Step 3: 实现 GStreamer 最新帧输入**

`VideoSource` 输出 RGB `Frame` 和 PTS。appsink 邮箱容量固定为 1，新帧覆盖旧帧。

本地 MP4：

```text
filesrc ! qtdemux ! h264parse ! mppvideodec ! videoconvert !
video/x-raw,format=RGB ! appsink max-buffers=1 drop=true sync=false
```

USB：读取 `/sys/class/video4linux/video*/name` 和父设备 `DRIVER=uvcvideo`，再用 `VIDIOC_QUERYCAP` 确认采集能力。格式优先 MJPEG 640×480@30，其次 MJPEG 1280×720@30、YUYV 640×480@30。不能固定 `/dev/video9`。

无摄像头时每 2 秒重扫；拔出后关闭旧管线并继续等待；重新插入后恢复。只记录状态变化，不对每次扫描重复打印错误。

`main.cpp` 增加：

```text
--input-smoke <video.mp4> --max-frames 30
```

- [ ] **Step 4: 板端运行 30 帧输入冒烟**

Run:

```powershell
& platforms/rk3566/build.ps1 -Target All
scp -i "$env:USERPROFILE\.ssh\id_ed25519" platforms/rk3566/media/yoga-regression.mp4 `
  root@192.168.31.230:/userdata/yoga-regression.mp4
scp -i "$env:USERPROFILE\.ssh\id_ed25519" build/rk3566-aarch64/poseguard-rk3566 `
  root@192.168.31.230:/userdata/poseguard-input-smoke
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" root@192.168.31.230 `
  "/userdata/poseguard-input-smoke --input-smoke /userdata/yoga-regression.mp4 --max-frames 30"
```

Expected: 打印 30 个递增 PTS、960×540 RGB 帧并退出 0。

- [ ] **Step 5: 提交**

```bash
git add platforms/rk3566
git commit -m "feat: capture RK3566 video sources"
```

### Task 6: 组装绘制、MJPEG、事件和完整应用

**Files:**
- Create: `platforms/rk3566/include/poseguard/runtime.hpp`
- Create: `platforms/rk3566/src/runtime.cpp`
- Create: `platforms/rk3566/config/poseguard.conf`
- Modify: `platforms/rk3566/src/main.cpp`
- Modify: `platforms/rk3566/CMakeLists.txt`

- [ ] **Step 1: 实现轻量画面叠加**

`runtime.cpp` 用自写的整数直线、矩形、圆和 5×7 ASCII 字模绘制 17 点骨架、ID、FPS 和风险名。正常黄 `(255,220,0)`，候选橙 `(255,140,0)`，告警红 `(255,0,0)`；同一人的多个风险取最强颜色。

- [ ] **Step 2: 实现单次 JPEG 与共享 HTTP**

每个处理帧只编码一次：

```text
appsrc is-live=true format=time ! videoconvert !
mppjpegenc q-factor=70 max-pending=1 !
appsink max-buffers=1 drop=true sync=false
```

板上已确认属性名为 `q-factor`。若硬件元素不可创建，回退 `jpegenc quality=70`。HTTP 提供：

```text
/
/stream.mjpg
/status.json
```

客户端只读取最新 JPEG，不保存帧队列。

- [ ] **Step 3: 实现 JSONL 状态变化事件**

仅在 candidate、alert、clear 状态变化时追加 `/userdata/poseguard/runs/events.jsonl`：

```json
{"timestamp":123.4,"video_pts":8.2,"track_id":7,"risk_kind":"phone_to_ear","state":"alert","duration_seconds":1.2,"bbox":[1,2,30,40],"fps":20.0,"inference_ms":18.0}
```

不写原始帧、图片、关键点或身份信息。事件写失败只更新 `/status.json` 的 `last_error`。

- [ ] **Step 4: 实现应用循环和配置**

主流程固定为：

```cpp
auto observations = engine.infer(frame, metrics);
auto tracks = core.update_tracks(observations, frame.timeline_seconds);
auto decisions = core.evaluate(tracks, frame.width, frame.height,
                               frame.timeline_seconds);
events.publish(decisions, frame.pts_seconds, metrics);
auto canvas = draw_overlay(frame, tracks, decisions, metrics);
jpeg.publish(canvas);
status.update(tracks, decisions, metrics);
```

视频风险计时使用 PTS。摄像头等待时进程保持 HTTP，并显示 `WAITING_FOR_USB_CAMERA` 占位图。命令行支持 `--config`、`--source video|camera`、`--video`、`--device`、`--benchmark`、`--max-frames` 和 `--no-http`；SIGINT/SIGTERM 正常释放资源。

`poseguard.conf` 默认：模型 `/userdata/poseguard/models/poseguard-yolo11n-pose-320-int8.rknn`、`source=camera`、HTTP 8081、风险阈值采用 Task 2 数值。

- [ ] **Step 5: 交叉编译并提交**

Run:

```powershell
& platforms/rk3566/build.ps1 -Target All
python -m pytest -q
git diff --check
```

Expected: 现有 Python 测试、精简的 RK3566 测试和 AArch64 构建通过。

```bash
git add platforms/rk3566
git commit -m "feat: complete RK3566 PoseGuard loop"
```

### Task 7: 部署、开机启动和一次板端验收

**Files:**
- Create: `platforms/rk3566/deploy.ps1`
- Create: `platforms/rk3566/service/S99poseguard`
- Create: `platforms/rk3566/README.md`
- Modify: `README.md`
- Create: `docs/rk3566-validation.md`

- [ ] **Step 1: 实现简化部署脚本**

`deploy.ps1` 默认连接 `root@192.168.31.230`，使用 `%USERPROFILE%\.ssh\id_ed25519`。部署目录：

```text
/userdata/poseguard/bin/poseguard-rk3566
/userdata/poseguard/models/poseguard-yolo11n-pose-320-int8.rknn
/userdata/poseguard/config/poseguard.conf
/userdata/poseguard/media/yoga-regression.mp4
/userdata/poseguard/runs/events.jsonl
/userdata/poseguard/logs/poseguard.log
```

更新前只保留一份 `/userdata/poseguard/backup/previous/`，上传到 `.new` 后核对 SHA-256 再 `mv`；不复制或替换板上 `/usr/lib/librknnrt.so`。

- [ ] **Step 2: 实现 Buildroot 开机脚本**

目标板 BusyBox 已确认支持以下参数：

```sh
start-stop-daemon -S -b -m -p /var/run/poseguard.pid \
  -O /userdata/poseguard/logs/poseguard.log \
  -x /userdata/poseguard/bin/poseguard-rk3566 -- \
  --config /userdata/poseguard/config/poseguard.conf
```

`S99poseguard` 提供 `start|stop|restart|status`。无 USB 摄像头不算服务启动失败。

- [ ] **Step 3: 部署并运行 120 帧冒烟**

Run:

```powershell
& platforms/rk3566/deploy.ps1
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" root@192.168.31.230 `
  "/userdata/poseguard/bin/poseguard-rk3566 --config /userdata/poseguard/config/poseguard.conf --source video --video /userdata/poseguard/media/yoga-regression.mp4 --benchmark --max-frames 120 --no-http"
```

Expected: 120 帧、至少一个有效人体、退出码 0；打印平均推理耗时、FPS 和峰值 RSS。

- [ ] **Step 4: 完整实时回放并检查输出**

启动视频实时模式并访问：

```text
http://192.168.31.230:8081/
http://192.168.31.230:8081/status.json
```

看到骨架、稳定 ID 和黄/橙/红框；完整视频到 EOS 正常退出；瑜伽明显动作不继承停留计时。检查 JSONL 每行可解析，并确认没有 `frame/image/keypoints` 字段。

- [ ] **Step 5: 安装服务并重启一次**

Run:

```powershell
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" root@192.168.31.230 `
  "install -m 0755 /userdata/poseguard/service/S99poseguard /etc/init.d/S99poseguard && /etc/init.d/S99poseguard restart && sleep 3 && /etc/init.d/S99poseguard status"
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" root@192.168.31.230 "sync; reboot"
Start-Sleep -Seconds 25
ssh -o ConnectTimeout=8 -i "$env:USERPROFILE\.ssh\id_ed25519" root@192.168.31.230 `
  "/etc/init.d/S99poseguard status; wget -qO- http://127.0.0.1:8081/status.json"
```

Expected: 重启后服务存在；无 USB 时 `input_state=waiting_for_usb_camera`；网页仍可访问。

- [ ] **Step 6: 记录实测并提交**

`docs/rk3566-validation.md` 只记录真实模型 SHA-256、Runtime/驱动、120 帧 FPS/耗时/RSS、完整回放、JSONL、开机结果。USB 项写“代码完成，待摄像头接入实测”，不进行额外模拟证明。

Run:

```powershell
& platforms/rk3566/build.ps1 -Target All
python -m pytest -q
git diff --check
```

```bash
git add platforms/rk3566 README.md docs/rk3566-validation.md
git commit -m "test: deploy PoseGuard to RK3566"
```

## 完成门禁

首版只要求：

1. RKNN 模型能在板端加载并输出 17 点；
2. 120 帧和完整瑜伽视频均不崩溃；
3. 网页显示轨迹、骨架和风险颜色；
4. 三类核心行为测试通过，瑜伽运动能重置停留；
5. JSONL 可解析且不保存图像；
6. 服务能开机启动，无摄像头时保持等待；
7. UVC 不依赖固定 `/dev/videoN`，真实热插拔待设备接入后再测。
