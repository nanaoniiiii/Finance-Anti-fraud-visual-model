# PoseGuard TaishanPi RK3566 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在泰山派 RK3566 Buildroot 上交付独立运行的 C++17 PoseGuard：本地视频或 USB 摄像头输入，YOLO11n-Pose 320×320 INT8 RKNN 推理，稳定人体轨迹，三类风险判断，MJPEG 网页、JSONL 事件和开机自启动。

**Architecture:** `platforms/rk3566` 内分为纯 C++ 业务核心、RKNN 推理、GStreamer 输入、绘制/编码/HTTP 和应用编排五层。纯业务核心在 x86 Docker 中先行测试；模型导出与 RKNN 转换固定使用 Docker；最终二进制由 AArch64 交叉工具链构建，只动态链接板上已验证的 RKNN Runtime 2.3.2 与 GStreamer 1.24。摄像头采集和网页消费都只保留最新一帧，USB 缺席或热拔插不会结束守护进程。

**Tech Stack:** C++17, CMake, RKNN Runtime C API 2.3.2, RKNN-Toolkit2 2.3.2, GStreamer 1.24, Rockchip MPP, POSIX sockets, Docker Desktop, PowerShell, Buildroot `start-stop-daemon`, pytest for host tooling.

---

## 固定约束与文件地图

- 目标板：`root@192.168.31.230`，SSH 密钥为 `%USERPROFILE%\.ssh\id_ed25519`。
- 板端部署根目录：`/userdata/poseguard`；不覆盖 `/usr/lib/librknnrt.so`。
- 输入模型：`models/yolo11n-pose.pt`；目标模型：`poseguard-yolo11n-pose-320-int8.rknn`。
- 测试视频源：`C:\Users\31919\Videos\NVIDIA\Desktop\Desktop 2026.08.29 - 18.49.55.01.mp4`。
- C++ 公共头文件放在 `platforms/rk3566/include/poseguard/`，实现放在 `platforms/rk3566/src/`。
- C++ 测试放在 `platforms/rk3566/tests/`，不引入外部单元测试框架。
- Python 工具测试放在 `tests/rk3566/`；生成的 ONNX、RKNN、校准帧、构建目录和媒体文件不提交 Git。
- 颜色使用 RGB：正常黄 `(255, 220, 0)`、候选橙 `(255, 140, 0)`、告警红 `(255, 0, 0)`。
- 贴耳风险只使用姿态证据；不加载手机检测模型。

### Task 1: 建立可复现的 C++ 测试和交叉编译骨架

**Files:**
- Modify: `.gitignore`
- Create: `platforms/rk3566/CMakeLists.txt`
- Create: `platforms/rk3566/cmake/aarch64-linux-gnu.cmake`
- Create: `platforms/rk3566/docker/toolchain.Dockerfile`
- Create: `platforms/rk3566/build.ps1`
- Create: `platforms/rk3566/include/poseguard/types.hpp`
- Create: `platforms/rk3566/src/main.cpp`
- Create: `platforms/rk3566/tests/test_main.cpp`
- Create: `platforms/rk3566/tests/test_support.hpp`
- Create: `platforms/rk3566/tests/test_types.cpp`

- [ ] **Step 1: 先写类型契约测试**

`test_support.hpp` 提供无依赖断言注册器；`test_types.cpp` 先要求 17 点固定长度和风险颜色映射：

```cpp
TEST_CASE(types_keep_exactly_seventeen_keypoints) {
  poseguard::PoseObservation observation{};
  CHECK_EQ(observation.keypoints.size(), std::size_t{17});
}

TEST_CASE(risk_state_has_fixed_rgb_colors) {
  CHECK_EQ(poseguard::color_for(poseguard::RiskState::Normal),
           (poseguard::Rgb{255, 220, 0}));
  CHECK_EQ(poseguard::color_for(poseguard::RiskState::Candidate),
           (poseguard::Rgb{255, 140, 0}));
  CHECK_EQ(poseguard::color_for(poseguard::RiskState::Alert),
           (poseguard::Rgb{255, 0, 0}));
}
```

- [ ] **Step 2: 创建 CMake，但暂不定义业务类型并验证 RED**

`CMakeLists.txt` 先建立三个边界清晰的 target：`poseguard_core` 只含标准 C++ 业务逻辑，`poseguard_board` 只在 `POSEGUARD_ENABLE_BOARD=ON` 时链接 RKNN/GStreamer，`poseguard-rk3566` 链接前两者；`poseguard_tests` 只链接 `poseguard_core` 并注册到 CTest。随后运行：

```powershell
docker build -f platforms/rk3566/docker/toolchain.Dockerfile --target native-test -t poseguard-rk3566-test .
docker run --rm -v "${PWD}:/workspace" -w /workspace poseguard-rk3566-test `
  cmake -S platforms/rk3566 -B build/rk3566-native -DPOSEGUARD_BUILD_TESTS=ON -DPOSEGUARD_ENABLE_BOARD=OFF
docker run --rm -v "${PWD}:/workspace" -w /workspace poseguard-rk3566-test `
  cmake --build build/rk3566-native -j2
```

Expected: 编译因 `PoseObservation`、`RiskState`、`Rgb` 和 `color_for` 尚未定义而失败。

- [ ] **Step 3: 实现固定容量基础类型**

`types.hpp` 至少定义：

```cpp
namespace poseguard {
constexpr std::size_t kKeypointCount = 17;
constexpr std::size_t kMaximumTracks = 8;

struct Point { float x{}; float y{}; };
struct BBox { float x1{}; float y1{}; float x2{}; float y2{}; };
struct Keypoint { float x{}; float y{}; float confidence{}; bool valid{}; };
struct Rgb {
  std::uint8_t r{}, g{}, b{};
  bool operator==(const Rgb& other) const {
    return r == other.r && g == other.g && b == other.b;
  }
};
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

同时定义 `TrackState`、`RiskDecision`、`Frame`、`RuntimeMetrics` 和 `ServiceStatus`，所有集合均使用固定数组或显式容量上限。

- [ ] **Step 4: 完成 Docker 两阶段工具链**

`toolchain.Dockerfile` 使用 Debian 12：

- `native-test` 安装 `g++ cmake ninja-build pkg-config valgrind`；
- `aarch64-build` 添加 `arm64` 架构，安装 `g++-aarch64-linux-gnu`、ARM64 GStreamer 开发包和 TurboJPEG 开发包；
- 从 Rockchip 官方仓库 `v2.3.2` 取得 `rknn_api.h` 和仅用于链接的 AArch64 `librknnrt.so`；
- 设置 `PKG_CONFIG_LIBDIR=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig`；
- 不把该 Runtime 库放入部署包。

`build.ps1` 提供 `-Target Test|Aarch64|All`，先执行 `docker info`，Docker 未就绪时给出明确错误；`Test` 运行 native CMake/CTest，`Aarch64` 将产物写到 `build/rk3566-aarch64/poseguard-rk3566`。

本任务的 `src/main.cpp` 先提供只输出版本和帮助信息的最小入口，使交叉工具链可在业务模块完成前生成真实 AArch64 ELF；Task 12 再把它替换为完整应用入口。

- [ ] **Step 5: 验证 GREEN 和交叉编译骨架**

Run:

```powershell
& platforms/rk3566/build.ps1 -Target Test
& platforms/rk3566/build.ps1 -Target Aarch64
```

Expected: CTest 显示 `100% tests passed`；`file build/rk3566-aarch64/poseguard-rk3566` 包含 `ELF 64-bit LSB pie executable, ARM aarch64`。

- [ ] **Step 6: 扩充忽略项并提交**

`.gitignore` 增加：

```gitignore
build/rk3566-*/
platforms/rk3566/artifacts/
platforms/rk3566/media/*.mp4
models/*.onnx
models/*.rknn
```

Run: `git diff --check`

```bash
git add .gitignore platforms/rk3566
git commit -m "build: scaffold RK3566 C++ toolchain"
```

### Task 2: 实现配置文件和命令行覆盖

**Files:**
- Create: `platforms/rk3566/include/poseguard/config.hpp`
- Create: `platforms/rk3566/src/config.cpp`
- Create: `platforms/rk3566/config/poseguard.conf`
- Create: `platforms/rk3566/tests/test_config.cpp`

- [ ] **Step 1: 写配置解析失败测试**

覆盖默认值、空白/注释、合法覆盖、未知键、非法范围和 CLI 优先级：

```cpp
TEST_CASE(command_line_overrides_file_source) {
  auto cfg = poseguard::Config::defaults();
  poseguard::apply_config_text(cfg, "source=camera\nhttp_port=8081\n");
  const char* argv[] = {"poseguard", "--source", "video", "--max-frames", "12"};
  poseguard::apply_command_line(cfg, 5, const_cast<char**>(argv));
  CHECK_EQ(cfg.source, poseguard::SourceKind::Video);
  CHECK_EQ(cfg.max_frames, 12);
}

TEST_CASE(reversed_region_is_rejected) {
  auto cfg = poseguard::Config::defaults();
  poseguard::apply_config_text(cfg, "region=0.9,0.1,0.2,0.8\n");
  CHECK_THROWS_WITH(poseguard::validate(cfg), "region must be ordered inside 0..1");
}
```

- [ ] **Step 2: 运行并验证 RED**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: `config.hpp` 或配置函数缺失导致构建失败。

- [ ] **Step 3: 实现无第三方依赖的严格解析器**

`Config` 包含模型、输入、UVC、质量、跟踪、风险、HTTP、JPEG、事件和运行模式字段。接口固定为：

```cpp
struct Config {
  static Config defaults();
  std::string model_path;
  SourceKind source{SourceKind::Camera};
  std::string video_path;
  std::string explicit_device;
  std::string uvc_name_contains{"USB Camera"};
  int camera_width{640}, camera_height{480}, camera_fps{30};
  float pose_confidence{0.35F}, keypoint_confidence{0.25F}, nms_iou{0.45F};
  int max_tracks{8};
  std::array<float, 4> region{0.05F, 0.05F, 0.95F, 0.95F};
  double phone_seconds{1.0}, multi_seconds{1.5}, lingering_seconds{20.0};
  double release_seconds{0.8};
  std::string http_host{"0.0.0.0"};
  int http_port{8081}, jpeg_quality{70};
  std::string event_path{"/userdata/poseguard/runs/events.jsonl"};
  PlaybackMode playback{PlaybackMode::Realtime};
  int max_frames{0};
  bool http_enabled{true};
};
Config load_config_file(const std::string& path);
void apply_command_line(Config&, int argc, char** argv);
void validate(const Config&);
```

未知键直接报错，布尔值只接受 `true/false`，所有浮点必须有限。命令行支持 `--config`、`--source`、`--video`、`--device`、`--benchmark`、`--max-frames`、`--no-http` 和 `--help`。

- [ ] **Step 4: 写默认板端配置**

`poseguard.conf` 使用 `source=camera`，模型和输出路径都位于 `/userdata/poseguard`；UVC 首选 `MJPG 640x480@30`，重扫间隔 2 秒；风险阈值与批准的设计一致。

- [ ] **Step 5: 运行测试并提交**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: 配置测试和 Task 1 测试全部通过。

```bash
git add platforms/rk3566
git commit -m "feat: parse RK3566 runtime configuration"
```

### Task 3: 移植姿态几何和观测质量过滤

**Files:**
- Create: `platforms/rk3566/include/poseguard/geometry.hpp`
- Create: `platforms/rk3566/src/geometry.cpp`
- Create: `platforms/rk3566/include/poseguard/observation_filter.hpp`
- Create: `platforms/rk3566/src/observation_filter.cpp`
- Create: `platforms/rk3566/tests/pose_fixtures.hpp`
- Create: `platforms/rk3566/tests/test_geometry.cpp`
- Create: `platforms/rk3566/tests/test_observation_filter.cpp`

- [ ] **Step 1: 写几何规则测试**

用合成 COCO 17 点覆盖尺度归一化腕耳距离、站立证据、缺腿不判站立、归一化区域和邻近人体：

```cpp
TEST_CASE(phone_side_requires_same_side_arm_and_standing_evidence) {
  auto person = fixtures::standing_person();
  person.keypoints[3] = {38, 35, .95F, true};
  person.keypoints[7] = {33, 55, .95F, true};
  person.keypoints[9] = {39, 39, .95F, true};
  CHECK(poseguard::is_standing(person, .30F));
  CHECK_EQ(poseguard::candidate_phone_sides(person, .13F),
           poseguard::PhoneSide::Left);
}
```

- [ ] **Step 2: 写质量过滤和双人去重测试**

覆盖：少于 6 个可见点、少于 3 个躯干点、框面积范围、框越界比例、重复骨架仅保留高质量者、同姿态但中心相隔 0.1 个身体尺度时两人均保留、共享点少于 4 时不去重。

- [ ] **Step 3: 运行并验证 RED**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: 几何和过滤接口尚未定义，测试编译失败。

- [ ] **Step 4: 实现几何函数**

公开接口：

```cpp
float distance(Point a, Point b);
bool inside_region(Point center, int width, int height,
                   const std::array<float, 4>& region);
bool is_standing(const PoseObservation&, float keypoint_threshold);
PhoneSide candidate_phone_sides(const PoseObservation&, float wrist_ear_ratio,
                                float keypoint_threshold = .30F);
bool nearby_people(Point a, float height_a, Point b, float height_b, float ratio);
float bbox_iou(BBox a, BBox b);
```

站立条件保持 `shoulder_y < hip_y < ankle_y` 且肩到踝至少为框高的 `0.45`；贴耳候选保持腕不低于肘超过框高 `0.06`、肘高于肩、腕耳距离不超过框高的 `0.13`。

- [ ] **Step 5: 实现质量排序和重复验证**

`ObservationFilter::apply(span, frame_size)` 先质量筛选，再按 `confidence + visible/17 + torso/4` 降序去重，最后恢复原检测顺序。重复必须同时满足：

```text
共享有效点 >= 4
平均关键点距离 / body_scale <= 0.05
并且 (IoU >= 0.45 或 中心距离 / body_scale <= 0.25)
```

- [ ] **Step 6: 验证并提交**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: 所有几何/过滤测试通过。

```bash
git add platforms/rk3566
git commit -m "feat: filter RK3566 pose observations"
```

### Task 4: 实现有界稳定人体轨迹

**Files:**
- Create: `platforms/rk3566/include/poseguard/track_manager.hpp`
- Create: `platforms/rk3566/src/track_manager.cpp`
- Create: `platforms/rk3566/tests/test_track_manager.cpp`

- [ ] **Step 1: 写轨迹生命周期测试**

测试连续 3 帧确认、短时漏检保留 ID、超过 1.5 秒删除、两人 ID 不同、轨迹总数不超过 8、可见帧不复用旧的缺失关键点：

```cpp
TEST_CASE(track_id_survives_short_quality_gap) {
  poseguard::TrackManager manager(fixtures::tracking_config());
  manager.update({fixtures::person_at(10, 20)}, 0.0);
  manager.update({fixtures::person_at(11, 20)}, 0.1);
  const auto confirmed = manager.update({fixtures::person_at(12, 20)}, 0.2);
  const int id = confirmed.front().track_id;
  const auto predicted = manager.update({}, 0.7);
  const auto recovered = manager.update({fixtures::person_at(15, 20)}, 0.8);
  CHECK_EQ(predicted.front().track_id, id);
  CHECK(predicted.front().predicted);
  CHECK_EQ(recovered.front().track_id, id);
  CHECK(!recovered.front().predicted);
}
```

- [ ] **Step 2: 写运动量测试**

覆盖平滑中心、累计路径、至少 4 个共享点才计算姿态运动，以及“共享点位移最大的四分之一”的归一化平均值。

- [ ] **Step 3: 运行并验证 RED**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: `TrackManager` 缺失导致编译失败。

- [ ] **Step 4: 实现确定性的贪心关联**

接口：

```cpp
class TrackManager {
 public:
  explicit TrackManager(TrackingConfig config);
  std::vector<TrackState> update(const std::vector<PoseObservation>&,
                                 double timestamp);
 private:
  std::array<std::optional<TrackState>, kMaximumTracks> tracks_{};
  int next_id_{1};
};
```

匹配代价固定为：

```cpp
cost = center_distance / body_scale;
cost += std::abs(std::log(observation_area / track_area)) * 0.15F;
cost += mean_shared_keypoint_distance / body_scale * 0.25F;
```

只接受 `cost <= 1.15`；相同代价按 `track_id`、`detection_index` 排序，保证重复回放稳定。平滑系数 `0.55`；预测帧不改变 `last_seen`、路径或姿态运动。

- [ ] **Step 5: 验证内存上限和提交**

Run:

```powershell
& platforms/rk3566/build.ps1 -Target Test
docker run --rm -v "${PWD}:/workspace" -w /workspace poseguard-rk3566-test `
  bash -lc "valgrind --error-exitcode=1 --leak-check=full build/rk3566-native/poseguard_tests"
```

Expected: 测试全绿，Valgrind 报告 `0 errors`。

```bash
git add platforms/rk3566
git commit -m "feat: track RK3566 person poses"
```

### Task 5: 实现三类姿态风险和告警滞回

**Files:**
- Create: `platforms/rk3566/include/poseguard/risk_engine.hpp`
- Create: `platforms/rk3566/src/risk_engine.cpp`
- Create: `platforms/rk3566/tests/test_risk_engine.cpp`

- [ ] **Step 1: 写姿态式贴耳风险测试**

首版不需要手机框。测试站立且单侧腕贴耳先橙色，持续 1 秒后红色；缺少腿部站立证据不触发；预测帧不推进候选计时；证据消失后保留红色 0.8 秒再解除。

```cpp
TEST_CASE(phone_pose_turns_alert_after_hold_without_phone_detector) {
  poseguard::RiskEngine engine(fixtures::risk_config());
  auto track = fixtures::phone_pose_track(1);
  auto first = engine.evaluate({track}, {640, 480}, 0.0);
  auto alert = engine.evaluate({track}, {640, 480}, 1.1);
  CHECK_EQ(fixtures::decision(first, 1, poseguard::RiskKind::PhoneToEar).state,
           poseguard::RiskState::Candidate);
  CHECK_EQ(fixtures::decision(alert, 1, poseguard::RiskKind::PhoneToEar).state,
           poseguard::RiskState::Alert);
}
```

- [ ] **Step 2: 写多人和停留测试**

覆盖：区域内两人 1.5 秒告警；区域外人员不计入；新人不继承旧计时；预测参与者重置未确认多人计时；静止 20 秒告警；明显姿态运动、未知姿态运动均重置停留窗口；短漏检不清除已累计停留时间。

- [ ] **Step 3: 运行并验证 RED**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: 风险引擎缺失导致编译失败。

- [ ] **Step 4: 实现按目标、按风险种类分离的状态机**

`RiskEngine::evaluate` 返回最多 `max_tracks * 3` 个决定。内部状态键为 `(track_id, RiskKind)`；预测轨迹可以保留既有红色状态，但不能创建或推进贴耳/多人证据。停留同时满足：

```text
框中心累计速度 / body_height <= 0.12 每秒
pose_motion_valid == true
pose_motion <= 0.04
持续 >= 20 秒
```

贴耳候选持续 `phone_seconds` 后直接告警，原因文本固定为 ASCII 标识 `PHONE_TO_EAR`；多人使用 `MULTI_PERSON` 或 `MULTI_PERSON_NEAR`；停留使用 `LINGERING`。

- [ ] **Step 5: 验证并提交**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: 三类风险、释放窗口和预测帧测试全部通过。

```bash
git add platforms/rk3566
git commit -m "feat: evaluate RK3566 pose risks"
```

### Task 6: 实现事件状态变化和服务状态序列化

**Files:**
- Create: `platforms/rk3566/include/poseguard/event_writer.hpp`
- Create: `platforms/rk3566/src/event_writer.cpp`
- Create: `platforms/rk3566/include/poseguard/status_json.hpp`
- Create: `platforms/rk3566/src/status_json.cpp`
- Create: `platforms/rk3566/tests/test_event_writer.cpp`
- Create: `platforms/rk3566/tests/test_status_json.cpp`

- [ ] **Step 1: 写事件隐私和转换测试**

测试同一状态不重复写、candidate→alert→clear 各写一行、JSON 可解析、不得出现 `frame`、`image` 或 `keypoints` 字段：

```cpp
TEST_CASE(event_writer_emits_only_transitions_without_images) {
  const auto path = fixtures::temporary_path("events.jsonl");
  poseguard::EventWriter writer(path);
  writer.publish({fixtures::alert_decision(7)}, 123.4, 8.2, {20.0, 18.0, 45.0});
  writer.publish({fixtures::alert_decision(7)}, 123.5, 8.3, {20.0, 18.0, 45.0});
  const auto text = fixtures::read_text(path);
  CHECK_EQ(fixtures::line_count(text), 1);
  CHECK(text.find("\"risk_kind\":\"phone_to_ear\"") != std::string::npos);
  CHECK(text.find("keypoints") == std::string::npos);
}
```

- [ ] **Step 2: 写状态 JSON 测试**

验证包含 `frames/fps/inference_ms/people/alerts/input_state/last_error`，并正确转义错误字符串；最近错误和最近事件各保留固定上限 8 条。

- [ ] **Step 3: 运行并验证 RED**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: 序列化组件缺失。

- [ ] **Step 4: 实现追加写和手工 JSON 转义**

事件字段固定为：

```json
{"timestamp":123.4,"video_pts":8.2,"track_id":7,"risk_kind":"phone_to_ear","state":"alert","duration_seconds":1.2,"bbox":[1,2,30,40],"fps":20.0,"inference_ms":18.0,"people":1}
```

每行立即 `flush`；打开或写入失败只更新 `ServiceStatus.last_error`，不让推理循环退出。`clear` 行由上一活动风险消失时产生。

- [ ] **Step 5: 验证并提交**

Run: `& platforms/rk3566/build.ps1 -Target Test`

```bash
git add platforms/rk3566
git commit -m "feat: serialize RK3566 events and status"
```

### Task 7: 导出静态 ONNX、校准集和输出契约

**Files:**
- Create: `platforms/rk3566/docker/model.Dockerfile`
- Create: `platforms/rk3566/tools/export_pose_onnx.py`
- Create: `platforms/rk3566/tools/extract_calibration.py`
- Create: `platforms/rk3566/tools/inspect_pose_output.py`
- Create: `platforms/rk3566/model.ps1`
- Create: `tests/rk3566/test_model_tools.py`

- [ ] **Step 1: 写模型工具参数和采样测试**

测试 40 张校准帧按 PTS 均匀选择、目录清单稳定排序、ONNX 契约只接受 batch 1、320×320、17 点和单人类别：

```python
def test_calibration_indices_cover_full_video():
    assert sample_indices(total_frames=631, count=5) == [0, 157, 315, 472, 630]

def test_pose_contract_accepts_56_by_2100_output():
    contract = normalize_contract(input_shape=[1, 3, 320, 320], output_shape=[1, 56, 2100])
    assert contract == {"layout": "BCN", "channels": 56, "anchors": 2100, "keypoints": 17}
```

- [ ] **Step 2: 运行并验证 RED**

Run: `python -m pytest tests/rk3566/test_model_tools.py -q`

Expected: 工具模块尚不存在，测试收集失败。

- [ ] **Step 3: 构建固定版本模型容器**

`model.Dockerfile` 基于 Python 3.10，固定：

- Rockchip `rknn-toolkit2` Git tag `v2.3.2`；
- 官方 `rknn_toolkit2-2.3.2-cp310-...whl` 和对应 requirements；
- `ultralytics==8.4.103`；
- `onnx`、`onnxruntime`、`onnxsim`、`opencv-python-headless`、`ffmpeg`。

镜像构建时校验 `python -c "from rknn.api import RKNN; print('rknn-2.3.2-ok')"`。

- [ ] **Step 4: 实现静态导出和契约记录**

`export_pose_onnx.py` 执行：

```python
model.export(format="onnx", imgsz=320, batch=1, dynamic=False,
             simplify=True, opset=12, nms=False)
```

`inspect_pose_output.py` 用 ONNX Runtime 对一张真实校准帧推理，允许输出布局 `[1,56,2100]` 或等价转置 `[1,2100,56]`，把真实输入名、输出名、布局和坐标语义写入 `platforms/rk3566/artifacts/model/pose-contract.json`。若通道不是 `4 + 1 + 17*3 = 56`，脚本返回非零，不猜测格式。

- [ ] **Step 5: 实现校准集和瑜伽回归媒体提取**

`extract_calibration.py` 从源视频全时段均匀抽取 40 帧到 `artifacts/calibration`。`model.ps1 -Action Media` 通过容器内 ffmpeg 生成：

```text
crop=960:540:210:215,fps=30,scale=960:540
H.264 High profile, yuv420p, faststart
```

输出为 `platforms/rk3566/media/yoga-regression.mp4`，不改动原视频。

- [ ] **Step 6: 运行测试和真实导出**

Run:

```powershell
python -m pytest tests/rk3566/test_model_tools.py -q
& platforms/rk3566/model.ps1 -Action BuildImage
& platforms/rk3566/model.ps1 -Action Export -SourceModel models/yolo11n-pose.pt
& platforms/rk3566/model.ps1 -Action Calibrate -SourceVideo "C:\Users\31919\Videos\NVIDIA\Desktop\Desktop 2026.08.29 - 18.49.55.01.mp4"
& platforms/rk3566/model.ps1 -Action Media -SourceVideo "C:\Users\31919\Videos\NVIDIA\Desktop\Desktop 2026.08.29 - 18.49.55.01.mp4"
```

Expected: ONNX 输入固定 320×320；契约打印真实输出布局和 17 点；校准目录 40 张图；媒体可由 `ffprobe` 识别为 960×540、30 FPS。

- [ ] **Step 7: 提交工具，不提交生成物**

Run: `git status --short`，确认 `artifacts/`、ONNX 和 MP4 未进入暂存列表。

```bash
git add platforms/rk3566/docker/model.Dockerfile platforms/rk3566/tools \
  platforms/rk3566/model.ps1 tests/rk3566
git commit -m "build: export RK3566 pose model inputs"
```

### Task 8: 实现 YOLO11n-Pose 解码并用 ONNX 输出夹具锁定语义

**Files:**
- Create: `platforms/rk3566/include/poseguard/yolo_pose_decoder.hpp`
- Create: `platforms/rk3566/src/yolo_pose_decoder.cpp`
- Create: `platforms/rk3566/tools/make_decoder_fixture.py`
- Create: `platforms/rk3566/tests/fixtures/pose-output-small.txt`
- Create: `platforms/rk3566/tests/test_yolo_pose_decoder.cpp`
- Modify: `tests/rk3566/test_model_tools.py`

- [ ] **Step 1: 先用合成输出写解码测试**

覆盖 BCN/BNC 转置、置信度过滤、`xywh→xyxy`、17 点置信度、letterbox 反映射、边界裁剪和 class-aware NMS：

```cpp
TEST_CASE(decoder_restores_letterboxed_coordinates_and_seventeen_points) {
  auto tensor = fixtures::single_pose_tensor(/*cx=*/160, /*cy=*/160,
                                             /*w=*/80, /*h=*/160, /*score=*/.9F);
  poseguard::LetterboxTransform tx{};
  tx.scale = .5F;
  tx.pad_x = 0;
  tx.pad_y = 40;
  tx.source_width = 640;
  tx.source_height = 480;
  auto people = poseguard::decode_yolo11_pose(tensor, {1, 56, 2100}, tx, {.35F,.25F,.45F});
  CHECK_EQ(people.size(), std::size_t{1});
  CHECK_EQ(people[0].keypoints.size(), std::size_t{17});
  CHECK_NEAR(people[0].bbox.x1, 240.0F, 0.5F);
}
```

- [ ] **Step 2: 运行并验证 RED**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: 解码函数缺失。

- [ ] **Step 3: 实现布局归一化、阈值和 NMS**

解码器只接收经查询确认的 56 通道输出。每个候选字段为 `[cx,cy,w,h,class,17*(x,y,kpt_conf)]`；低于人体阈值的候选丢弃；关键点低于阈值标记 `valid=false`；先还原 letterbox 再裁剪到源图；按人体置信度降序做 IoU NMS，最多输出 `max_tracks * 2` 个原始候选，防止异常输出扩大内存。

- [ ] **Step 4: 从真实 ONNX 输出制作小型黄金夹具**

`make_decoder_fixture.py` 对固定校准图执行 ONNX Runtime，将最高分候选及与其重叠的候选写成文本夹具，同时写期望框与 17 点。夹具只含数值张量和期望结果，不含原始图片。

Run:

```powershell
& platforms/rk3566/model.ps1 -Action DecoderFixture
& platforms/rk3566/build.ps1 -Target Test
```

Expected: 合成测试和真实 ONNX 小夹具测试均通过；解码得到的人数、最高分框和关键点在 `1.0 px` 容差内。

- [ ] **Step 5: 提交**

```bash
git add platforms/rk3566/include platforms/rk3566/src platforms/rk3566/tests \
  platforms/rk3566/tools tests/rk3566
git commit -m "feat: decode YOLO11 pose outputs"
```

### Task 9: 转换 INT8 RKNN 并实现 RKNN Runtime 推理

**Files:**
- Create: `platforms/rk3566/tools/convert_pose_rknn.py`
- Create: `platforms/rk3566/tools/compare_pose_outputs.py`
- Create: `platforms/rk3566/include/poseguard/rknn_pose_engine.hpp`
- Create: `platforms/rk3566/src/rknn_pose_engine.cpp`
- Create: `platforms/rk3566/tests/test_letterbox.cpp`
- Modify: `platforms/rk3566/model.ps1`
- Modify: `platforms/rk3566/CMakeLists.txt`
- Modify: `platforms/rk3566/src/main.cpp`
- Create: `tests/rk3566/test_compare_pose_outputs.py`

- [ ] **Step 1: 写转换比较与 letterbox 测试**

Python 测试验证匹配算法按 IoU 对齐 ONNX/RKNN 人体，并检查框中心误差、框尺寸误差、有效关键点平均误差和漏检率。C++ 测试验证 RGB 输入被正确缩放、填充到 320×320，空白区像素固定为 114。

- [ ] **Step 2: 运行并验证 RED**

Run:

```powershell
python -m pytest tests/rk3566/test_compare_pose_outputs.py -q
& platforms/rk3566/build.ps1 -Target Test
```

Expected: 转换比较和 letterbox 实现缺失。

- [ ] **Step 3: 实现 RKNN 转换脚本**

`convert_pose_rknn.py` 固定：

```python
rknn.config(target_platform="rk3566", mean_values=[[0, 0, 0]],
            std_values=[[255, 255, 255]], optimization_level=3)
rknn.load_onnx(model=onnx_path)
rknn.build(do_quantization=True, dataset=dataset_txt)
rknn.export_rknn(output_path)
```

脚本检查每个 API 返回码，打印 Toolkit 版本，并写 SHA-256 清单。首次量化失败时只按设计中的顺序尝试静态图、opset 12、ONNX simplify；混合量化只有在日志明确指出量化敏感层时单独记录并启用，不静默换模型。

- [ ] **Step 4: 生成并比较模型**

Run:

```powershell
& platforms/rk3566/model.ps1 -Action Convert
& platforms/rk3566/model.ps1 -Action Compare
```

Expected: 生成 `artifacts/model/poseguard-yolo11n-pose-320-int8.rknn`；比较报告至少覆盖 10 张校准外帧，匹配人体框 IoU 中位数不低于 `0.75`，有效关键点平均误差不高于源图人体高度的 `0.05`，人数差异逐帧列出。若未达标，停止本任务并根据报告调整量化，不进入部署。

- [ ] **Step 5: 实现板端 RKNN 引擎**

`RknnPoseEngine` 生命周期固定为：读取模型→`rknn_init`→查询 SDK/驱动版本→查询输入输出数量和属性→验证 320×320 RGB/NHWC 与 56 通道输出→每帧 letterbox→`rknn_inputs_set`→`rknn_run`→`rknn_outputs_get`→反量化→解码→`rknn_outputs_release`。

```cpp
class RknnPoseEngine {
 public:
  explicit RknnPoseEngine(const Config&);
  ~RknnPoseEngine();
  std::vector<PoseObservation> infer(const Frame&, RuntimeMetrics&);
 private:
  rknn_context context_{};
  std::vector<rknn_tensor_attr> output_attrs_;
};
```

INT8 反量化使用 `(value - zero_point) * scale`；FLOAT32 输出直接读取。输入/输出数量、维度、类型或量化属性不符时构造函数抛出包含实际属性的错误。

同步扩展最小入口：`--model-smoke <model.rknn>` 创建引擎、用一张 320×320 灰色 RGB 帧执行一次推理、打印 Runtime/驱动和张量属性后退出；它不启动 GStreamer 或 HTTP。

- [ ] **Step 6: 构建 AArch64 并做模型加载冒烟**

Run:

```powershell
& platforms/rk3566/build.ps1 -Target All
scp -i "$env:USERPROFILE\.ssh\id_ed25519" `
  platforms/rk3566/artifacts/model/poseguard-yolo11n-pose-320-int8.rknn `
  root@192.168.31.230:/userdata/poseguard-model-smoke.rknn
scp -i "$env:USERPROFILE\.ssh\id_ed25519" `
  build/rk3566-aarch64/poseguard-rk3566 root@192.168.31.230:/userdata/poseguard-model-smoke
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" root@192.168.31.230 `
  "chmod +x /userdata/poseguard-model-smoke && /userdata/poseguard-model-smoke --model-smoke /userdata/poseguard-model-smoke.rknn"
```

Expected: 输出 Runtime `2.3.2`、驱动 `0.9.8`、真实输入输出属性，并完成一次 NPU 推理；退出码 0。

- [ ] **Step 7: 提交代码和工具**

```bash
git add platforms/rk3566 tests/rk3566
git commit -m "feat: run YOLO11 pose with RKNN"
```

### Task 10: 实现 GStreamer 本地视频、USB 发现和热插拔输入

**Files:**
- Create: `platforms/rk3566/include/poseguard/video_source.hpp`
- Create: `platforms/rk3566/src/gst_video_source.cpp`
- Create: `platforms/rk3566/include/poseguard/uvc_discovery.hpp`
- Create: `platforms/rk3566/src/uvc_discovery.cpp`
- Create: `platforms/rk3566/src/resilient_camera_source.cpp`
- Create: `platforms/rk3566/tests/test_uvc_discovery.cpp`
- Create: `platforms/rk3566/tests/test_latest_frame.cpp`
- Create: `platforms/rk3566/tests/fixtures/sysfs/rkisp/video0/name`
- Create: `platforms/rk3566/tests/fixtures/sysfs/usb/video9/name`
- Create: `platforms/rk3566/tests/fixtures/sysfs/usb/video9/device/uevent`
- Modify: `platforms/rk3566/CMakeLists.txt`
- Modify: `platforms/rk3566/src/main.cpp`

- [ ] **Step 1: 写模拟 sysfs 发现测试**

测试排除 `rkisp_mainpath`、metadata/统计节点，只接受父设备 `DRIVER=uvcvideo` 且 `VIDIOC_QUERYCAP` 返回 `V4L2_CAP_VIDEO_CAPTURE` 或 `V4L2_CAP_VIDEO_CAPTURE_MPLANE` 的节点；节点能力探针通过接口注入，主机夹具不打开真实设备；显式 `--device` 优先；节点号变化后可重新发现 `/dev/video10`。

```cpp
TEST_CASE(uvc_discovery_ignores_internal_rkisp_nodes) {
  auto devices = poseguard::discover_uvc_devices(fixtures::sysfs_root());
  CHECK_EQ(devices.size(), std::size_t{1});
  CHECK_EQ(devices.front().device_path, "/dev/video9");
  CHECK(devices.front().name.find("USB Camera") != std::string::npos);
}
```

- [ ] **Step 2: 写最新帧邮箱测试**

连续发布序号 1、2、3，只允许消费者取得 3；容量恒为 1；关闭后等待线程立即返回。

- [ ] **Step 3: 运行并验证 RED**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: 输入组件缺失。

- [ ] **Step 4: 实现本地视频管线**

`GstVideoSource` 使用 appsink 回调写入 `LatestFrameMailbox`。视频管线：

```text
filesrc location=... ! qtdemux ! queue max-size-buffers=2 leaky=downstream !
h264parse ! mppvideodec ! videoconvert ! video/x-raw,format=RGB !
appsink name=poseguard_sink max-buffers=1 drop=true sync=false
```

无法确认 H.264 时使用 `decodebin` 并记录实际解码器。实时模式按 PTS 节奏等待；benchmark 模式不等待；风险引擎始终接收视频 PTS，不使用处理速度累计风险时间。EOS 正常返回，退出码 0。

- [ ] **Step 5: 实现 UVC 管线协商与重连**

候选顺序：MJPEG 640×480@30、MJPEG 1280×720@30、YUYV 640×480@30；实现通过 V4L2 ioctl 枚举格式、分辨率和帧间隔，从设备真实能力中选择第一个匹配项，不从日志文本猜测。管线统一为 RGB appsink，并含：

```text
queue max-size-buffers=1 leaky=downstream
appsink max-buffers=1 drop=true sync=false
```

`ResilientCameraSource` 状态机为 `Waiting→Opening→Streaming→Disconnected→Waiting`；未连接时每 2 秒重扫并保留 HTTP；拔出时清空邮箱、关闭旧管线、记录错误一次；重插后自动恢复。

同步加入 `--input-smoke <video> --max-frames <N>` 诊断入口，只初始化 GStreamer 源并打印每帧 `sequence,width,height,pts`，不加载 RKNN 模型。

- [ ] **Step 6: 主机测试和板端本地视频采集冒烟**

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

Expected: 读取 30 个递增 PTS 的 RGB 帧，报告实际尺寸，EOS/停止均无崩溃。

- [ ] **Step 7: 提交**

```bash
git add platforms/rk3566
git commit -m "feat: capture RK3566 video and UVC frames"
```

### Task 11: 实现叠加、单次 JPEG 编码和共享 MJPEG 服务

**Files:**
- Create: `platforms/rk3566/include/poseguard/overlay.hpp`
- Create: `platforms/rk3566/src/overlay.cpp`
- Create: `platforms/rk3566/include/poseguard/jpeg_publisher.hpp`
- Create: `platforms/rk3566/src/jpeg_publisher.cpp`
- Create: `platforms/rk3566/include/poseguard/http_server.hpp`
- Create: `platforms/rk3566/src/http_server.cpp`
- Create: `platforms/rk3566/tests/test_overlay.cpp`
- Create: `platforms/rk3566/tests/test_jpeg_cache.cpp`
- Create: `platforms/rk3566/tests/test_http_server.cpp`
- Modify: `platforms/rk3566/CMakeLists.txt`

- [ ] **Step 1: 写像素级绘制测试**

输入全黑 RGB 图，分别绘制 normal/candidate/alert 轨迹，验证原图对象未被修改、输出尺寸不变、框像素为黄/橙/红；17 点只连接双方都有效的 COCO 骨架边；预测轨迹使用虚线且不显示新风险。

- [ ] **Step 2: 写 JPEG 缓存与 HTTP 测试**

两个模拟客户端读取同一帧时 `encoded_frame_count` 只增加 1；慢客户端跳到最新 sequence；`/status.json` 返回合法 JSON；断开客户端不影响服务器；超过 8 个客户端返回 503。

- [ ] **Step 3: 运行并验证 RED**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: 绘制、缓存和 HTTP 类缺失。

- [ ] **Step 4: 实现原创轻量绘制器**

不复制 OpenCV 绘图实现。用整数 Bresenham 线、矩形、圆和自定义 5×7 ASCII 字模绘制：`ID`、`PHONE`、`MULTI`、`LINGER`、FPS、推理耗时和输入状态。多个风险取最强状态颜色，标签合并但每目标最多两行。

- [ ] **Step 5: 实现每处理帧只编码一次**

`JpegPublisher::publish(const Frame&)` 把 RGB 帧送入：

```text
appsrc is-live=true format=time ! videoconvert !
mppjpegenc q-factor=<quality> max-pending=1 !
appsink max-buffers=1 drop=true sync=false
```

目标板已实查 `mppjpegenc` 的质量属性名为 `q-factor`。若该元素创建失败，回退 `jpegenc quality=<quality>` 并在状态 JSON 标记实际编码器。编码后的 `shared_ptr<const vector<uint8_t>>` 和递增 sequence 原子替换；客户端不保存历史帧。

- [ ] **Step 6: 实现最小 POSIX HTTP 服务**

路由固定：`/`、`/stream.mjpg`、`/status.json`。服务线程数和客户端数均上限 8；每个 MJPEG 客户端等待 sequence 变化后发送最新 JPEG；`EPIPE/ECONNRESET` 只关闭对应 socket；停止时关闭监听 socket 并唤醒所有等待者。

- [ ] **Step 7: 验证并提交**

Run:

```powershell
& platforms/rk3566/build.ps1 -Target Test
& platforms/rk3566/build.ps1 -Target Aarch64
```

Expected: 单次编码、HTTP 和绘制测试通过，AArch64 链接成功。

```bash
git add platforms/rk3566
git commit -m "feat: publish RK3566 MJPEG alerts"
```

### Task 12: 组装应用生命周期和完整本地视频闭环

**Files:**
- Create: `platforms/rk3566/include/poseguard/application.hpp`
- Create: `platforms/rk3566/src/application.cpp`
- Modify: `platforms/rk3566/src/main.cpp`
- Create: `platforms/rk3566/tests/test_application.cpp`
- Modify: `platforms/rk3566/CMakeLists.txt`

- [ ] **Step 1: 写注入式应用流程测试**

用假的 `VideoSource`、`PoseEngine`、`JpegPublisher` 和 `EventWriter` 验证：质量过滤发生在跟踪前；EOS 返回 0；推理异常帧被丢弃；`max_frames` 精确停止；SIGTERM 路径依次停止输入、HTTP、编码和 RKNN；视频 PTS 传入风险引擎。

- [ ] **Step 2: 运行并验证 RED**

Run: `& platforms/rk3566/build.ps1 -Target Test`

Expected: `Application` 缺失。

- [ ] **Step 3: 实现编排顺序**

主循环固定为：

```cpp
while (!stop_requested()) {
  auto frame = source_->next_frame();
  if (frame.eos) break;
  auto observations = observation_filter_.apply(pose_engine_->infer(frame, metrics), frame.size());
  auto tracks = track_manager_.update(observations, frame.timeline_seconds);
  auto decisions = risk_engine_.evaluate(tracks, frame.size(), frame.timeline_seconds);
  event_writer_.publish(decisions, wall_clock_seconds(), frame.pts_seconds, metrics);
  auto canvas = overlay_.render(frame, tracks, decisions, metrics, status_);
  jpeg_publisher_.publish(canvas);
  status_.record_frame(tracks, decisions, metrics);
}
```

事件转换在画面发布前写入；事件失败不终止；HTTP 失败仅禁用网页；模型初始化失败则进程返回非零。摄像头等待状态仍持续生成低频占位 JPEG，使网页可见 `WAITING_FOR_USB_CAMERA`。

- [ ] **Step 4: 实现命令入口和信号处理**

`main.cpp` 从此前诊断入口扩展为：加载配置、应用 CLI、安装 `SIGINT/SIGTERM` 原子标志并调用 `Application::run()`；保留已通过板端冒烟的 `--model-smoke` 和 `--input-smoke`，便于继续隔离故障。

- [ ] **Step 5: 完整主机和交叉构建验证**

Run:

```powershell
& platforms/rk3566/build.ps1 -Target All
python -m pytest -q
git diff --check
```

Expected: C++ CTest、现有 Python 测试和 RK3566 工具测试全部通过；AArch64 二进制成功生成。

- [ ] **Step 6: 提交**

```bash
git add platforms/rk3566
git commit -m "feat: assemble RK3566 PoseGuard runtime"
```

### Task 13: 实现原子部署、Buildroot 开机启动和回滚

**Files:**
- Create: `platforms/rk3566/deploy.ps1`
- Create: `platforms/rk3566/service/S99poseguard`
- Create: `tests/rk3566/test_deploy_script.py`
- Create: `tests/rk3566/test_service_script.py`
- Modify: `README.md`
- Create: `platforms/rk3566/README.md`

- [ ] **Step 1: 写部署脚本静态测试**

验证脚本包含 SSH BatchMode、独立 staging 目录、SHA-256 校验、逐文件备份、原子 `mv`、服务停止/恢复和错误退出；验证任何路径都不写 `/usr/lib/librknnrt.so`。

- [ ] **Step 2: 写服务脚本测试**

用临时目录和假的 `start-stop-daemon` 执行 `start|stop|restart|status` 分支测试；无摄像头不视为启动失败；PID 文件固定 `/var/run/poseguard.pid`；日志固定 `/userdata/poseguard/logs/poseguard.log`。目标板 BusyBox v1.37.0 已实查支持 `-S/-K/-b/-m/-p/-x/-O`。

- [ ] **Step 3: 运行并验证 RED**

Run: `python -m pytest tests/rk3566/test_deploy_script.py tests/rk3566/test_service_script.py -q`

Expected: 脚本尚不存在。

- [ ] **Step 4: 实现部署脚本**

`deploy.ps1` 参数：

```powershell
param(
  [string]$HostName = "192.168.31.230",
  [string]$UserName = "root",
  [string]$KeyPath = "$env:USERPROFILE\.ssh\id_ed25519",
  [ValidateSet("Install", "Update", "Rollback", "VideoTest")]
  [string]$Action = "Update"
)
```

上传二进制、RKNN、配置、媒体和 service 文件到 `/userdata/poseguard/.staging-<UTC>`；本地与远端 `sha256sum` 一致后，将当前文件分别复制到 `/userdata/poseguard/backup/<UTC>/`，再在同一文件系统内 `mv` 替换。任一步失败停止替换并恢复原服务状态。最多保留 3 个备份目录，删除目标前先验证其绝对路径位于 `/userdata/poseguard/backup/`。

- [ ] **Step 5: 实现 Buildroot 服务脚本**

`S99poseguard` 使用 `start-stop-daemon` 和 PID 文件，启动分支固定为：

```sh
start-stop-daemon -S -b -m -p /var/run/poseguard.pid \
  -O /userdata/poseguard/logs/poseguard.log \
  -x /userdata/poseguard/bin/poseguard-rk3566 -- \
  --config /userdata/poseguard/config/poseguard.conf
```

默认配置为 camera；未发现 UVC 时应用保持运行并提供网页。`status` 同时检查 PID 与 `kill -0`，陈旧 PID 文件自动清理。

- [ ] **Step 6: 补充精确文档**

`platforms/rk3566/README.md` 记录 Docker 启动、模型构建、C++ 构建、部署、本地视频测试、服务管理、网页 URL、事件路径、USB 发现和回滚命令。根 `README.md` 增加入口链接，不改写 Windows/Maix 用法。

- [ ] **Step 7: 测试并提交**

Run:

```powershell
python -m pytest tests/rk3566 -q
& platforms/rk3566/build.ps1 -Target All
git diff --check
```

```bash
git add platforms/rk3566 tests/rk3566 README.md
git commit -m "feat: deploy RK3566 PoseGuard service"
```

### Task 14: 板端本地视频验收、开机验收和运行报告

**Files:**
- Create: `docs/rk3566-validation.md`
- Modify: `platforms/rk3566/config/poseguard.conf` only if measured thresholds require correction

- [ ] **Step 1: 记录部署前基线并安装**

Run:

```powershell
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" root@192.168.31.230 `
  "uname -a; cat /etc/os-release; sha256sum /usr/lib/librknnrt.so; df -h /userdata; free -m"
& platforms/rk3566/deploy.ps1 -Action Install
```

Expected: 基线写入本地终端记录；部署后 `/userdata/poseguard` 文件齐全；系统 RKNN Runtime 哈希与部署前一致。

- [ ] **Step 2: 运行 120 帧本地视频冒烟**

Run:

```powershell
& platforms/rk3566/deploy.ps1 -Action VideoTest
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" root@192.168.31.230 `
  "/userdata/poseguard/bin/poseguard-rk3566 --config /userdata/poseguard/config/poseguard.conf --source video --video /userdata/poseguard/media/yoga-regression.mp4 --benchmark --max-frames 120 --no-http"
```

Expected: 退出码 0；输出 120 帧、平均 NPU/后处理/总耗时、FPS 和峰值 RSS；至少检测到一个有效 17 点人体；无未捕获异常。

- [ ] **Step 3: 完整实时回放并检查网页**

远程启动实时视频模式后，在 Windows 访问：

- `http://192.168.31.230:8081/`
- `http://192.168.31.230:8081/status.json`
- `http://192.168.31.230:8081/stream.mjpg`

观察整个视频到 EOS：人体 ID 在短时漏检时保持；瑜伽明显运动不触发或继承停留告警；重叠检测不出现重复 ID 乱飞；MJPEG 不随时间增加延迟。使用 3 个同时客户端验证只编码一次。

- [ ] **Step 4: 校验 JSONL 和隐私边界**

Run:

```powershell
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" root@192.168.31.230 `
  "wc -l /userdata/poseguard/runs/events.jsonl; grep -E '\"(frame|image|keypoints)\"' /userdata/poseguard/runs/events.jsonl && exit 1 || true"
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" root@192.168.31.230 `
  "awk 'NF' /userdata/poseguard/runs/events.jsonl" | python -c `
  "import json,sys; [json.loads(x) for x in sys.stdin]; print('jsonl-ok')"
```

Expected: 每个非空行可解析；无原始帧、图片或关键点字段。

- [ ] **Step 5: 安装开机脚本并验证无摄像头等待**

Run:

```powershell
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" root@192.168.31.230 `
  "install -m 0755 /userdata/poseguard/service/S99poseguard /etc/init.d/S99poseguard && /etc/init.d/S99poseguard restart && sleep 3 && /etc/init.d/S99poseguard status"
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" root@192.168.31.230 `
  "wget -qO- http://127.0.0.1:8081/status.json"
```

Expected: 服务进程存活，`input_state` 为 `waiting_for_usb_camera`，HTTP 正常，日志不高速重复刷屏。

- [ ] **Step 6: 重启验证**

Run:

```powershell
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" root@192.168.31.230 "sync; reboot"
Start-Sleep -Seconds 25
ssh -o ConnectTimeout=8 -i "$env:USERPROFILE\.ssh\id_ed25519" root@192.168.31.230 `
  "/etc/init.d/S99poseguard status; wget -qO- http://127.0.0.1:8081/status.json"
```

Expected: SSH 恢复；服务自动启动；无 USB 时继续等待；网页可访问。

- [ ] **Step 7: 记录当前无法完成的硬件热插拔验收边界**

在 `docs/rk3566-validation.md` 明确写明 USB 摄像头当前未连接，因此本轮已完成模拟 sysfs、服务等待和重连状态机测试；真实 UVC 接入后执行：识别节点、MJPEG 640×480@30 协商、延迟观察、拔出等待、重新插入恢复。不要把这一项标成实机通过。

- [ ] **Step 8: 写入实测运行报告**

报告必须填入命令真实输出：

- RKNN Toolkit/Runtime/驱动版本与模型 SHA-256；
- 模型推理、后处理、JPEG 和总帧耗时；
- benchmark 与 realtime FPS；
- `VmHWM` 峰值内存；
- `/sys/class/thermal/thermal_zone*/temp` 温度；
- 120 帧和完整回放结果；
- MJPEG 客户端数量与编码计数；
- JSONL 行数；
- 开机、停止、状态、重启结果；
- UVC 实机项当前状态。

- [ ] **Step 9: 最终回归和提交**

Run:

```powershell
& platforms/rk3566/build.ps1 -Target All
python -m pytest -q
git diff --check
git status --short
```

Expected: 所有自动测试通过；只有预期文档或阈值修改未提交；生成物仍被忽略。

```bash
git add docs/rk3566-validation.md platforms/rk3566/config/poseguard.conf
git commit -m "test: validate PoseGuard on RK3566"
```

## 设计追踪矩阵

| 设计章节 | 实施任务 |
|---|---|
| 1 目标、三类风险 | Tasks 5、12、14 |
| 2 已验证目标环境 | Tasks 1、9、14 |
| 3 C++ RKNN 路线 | Tasks 1、9、12 |
| 4 模型转换 | Tasks 7、8、9 |
| 5 板端组件边界与有界数据 | Tasks 1、3–6、8–12 |
| 6 本地视频与 USB UVC | Tasks 7、10、12、14 |
| 7 跟踪和风险语义 | Tasks 3、4、5 |
| 8 MJPEG 与 JSONL | Tasks 6、11、12 |
| 9 配置和命令行 | Task 2 |
| 10 部署和开机启动 | Tasks 13、14 |
| 11 异常处理 | Tasks 6、9–13 |
| 12 主机与板端测试 | 每个任务的 RED/GREEN 步骤及 Task 14 |
| 13 完成标准 | Task 14 与下方门禁 |

## 完成门禁

执行者在宣布完成前逐项核对：

1. 模型确实是仓库 YOLO11n-Pose 导出的 320×320 INT8 RKNN，且板端 Runtime 2.3.2 成功加载；
2. C++ 业务规则测试覆盖多人、姿态式贴耳、停留、运动重置、预测帧和释放窗口；
3. 本地瑜伽视频 120 帧及完整 EOS 都退出码 0；
4. 网页显示稳定 ID、17 点骨架和黄/橙/红风险状态，多个客户端不重复编码；
5. JSONL 只记录状态变化且不含原始图像；
6. 摄像头输入不依赖固定 `/dev/videoN`，无 USB 时服务不退出；
7. 开机脚本经过一次真实重启；
8. 部署脚本完成哈希校验、备份和原子替换，系统 RKNN Runtime 未变化；
9. 运行报告只填实测值，USB 热插拔未接硬件时保持“待实机验收”。
