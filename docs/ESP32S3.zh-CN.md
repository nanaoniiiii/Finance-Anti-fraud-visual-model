# XIAO ESP32-S3 Sense 本地模型部署

1.6.0 在 XIAO ESP32-S3 Sense 本机执行姿态 INT8 模型、跟踪及风险判断。发布包采用 192×192 输入模型，摄像头画面为 320×240。128×128 剪枝试验约 10.9 次完整推理/秒，在通用场景中有较多误报，正式发行采用在原视频及通用场景检查中表现更可靠的 192 模型。[帧率与质量验证记录](esp32s3-fps-validation-2026-11-16.md)

## 硬件与文件

本固件针对 XIAO ESP32-S3 Sense，相机引脚采用该板官方定义，需要 8MB Flash 和 8MB OPI PSRAM。新分区表保留原布局：应用 2MB，LittleFS 自 `0x210000` 起、大小 `0x5e0000`。模型约 3.1MB，保存在 LittleFS，加载到 PSRAM 执行。

- 应用：`poseguard_s3.bin`。
- 默认模型：`pose-s3-192-minmax.espdl`，约 3.10MB。
- 可选模型：224/320 minmax 与 256/320 percentile；与默认模型使用相同原始权重。
- 模型转换和串口测试工具位于 `platforms/esp32s3/tools`。
- 模型对比数据见 [esp32s3-model-benchmarks.json](esp32s3-model-benchmarks.json)。

升级已有 PoseGuard 设备只写应用分区，保留 NVS、绑定、本地事件及模型：

```powershell
python -m esptool --chip esp32s3 --port COM11 --baud 115200 --after hard_reset write_flash --flash_mode keep --flash_size keep --flash_freq keep 0x10000 poseguard_s3.bin
```

端口按系统实际分配调整。首次使用空白板时，按照发行包 `flash_args.json` 中的地址写入匹配的 bootloader、分区表、OTA 初始数据和应用；不要把更新已有板子的命令扩展成擦除整片 Flash。

## 首次配置

串口使用原生 USB 调试口。串口波特率对该 USB 字节流没有影响，普通命令按行发送：

```text
STATUS
WIFI 你的2.4GHz网络名|你的Wi-Fi密码
BIND 网页为ESP32-S3生成的一次性绑定码
```

仅在全新板或确认文件系统尚未初始化时发送 `INIT_STORAGE`。它会格式化应用的本地文件系统并重启。已绑定和已有事件的设备不要执行该命令。

安装 Python 的 `pyserial`、`opencv-python` 后，上传并保存默认模型：

```powershell
python tools/board_video_test.py --port COM11 --model models/pose-s3-192-minmax.espdl --save-model --output local-model-install
```

模型传输逐块确认并校验 SHA256，启动时也校验完整模型。空间不足时不会自动删除本地事件；确认要替换旧模型时增加 `--replace-model`，只替换已校验的模型文件，保留绑定与事件。不要同时打开多个串口工具。

## 视频和方向测试

```powershell
python platforms/esp32s3/tools/board_video_test.py --port COM11 --video 你的测试视频.mp4 --stride 6 --correction -1 --readback --output local-video-test
```

`--correction -1` 自动选择方向；手动支持 0/90/180/270。`--source-rotation` 可以旋转测试输入，以验证不同安装方向。该测试模式在芯片上真实执行推理、生成本地事件和目标截图，通过串口读取并逐块校验；测试事件不进入真实云端告警队列。

正式摄像头检测时，在网页或 App 的设备预览中选择自动或手动安装方向。校正发生在推理前，预览中的框和关键点按对应画面变换。自动方向需要有效人体观测；空画面保持既有方向，避免无目标时反复旋转。

## 预览与网络

检测始终在本地继续运行，只有有人点击预览时上传画面。原始画面与姿态画面通过同一条上行连接传送；姿态画面使用真正参与该次推理的 JPEG 和对应关键点。各观看端独立确认消费进度，慢端丢弃过期画面，避免积压历史视频。不同观看模式只请求所需画面。

优先使用 WSS；连接或帧确认异常时可切换为独立 HTTPS 请求回传，并设整体响应读取期限。云端通过已认证心跳提供短时有效的 CDN 地址候选，设备继续校验原域名、SNI 和 CA。候选会过期并重新解析，不固定终端 IP，也不要求路由器端口映射。

默认 192 输入模型在真实摄像头上约 3 次完整推理/秒。原始画面可以使用更高的采集速率，姿态画面只在新推理完成时更新。光照不足、过曝或对比度极低的画面会提示检测不可用，避免将传感器噪声解释为人员风险。[各模型与预览测量结果](esp32s3-fps-validation-2026-11-16.md)

首次安装并保存模型后重启设备，让预览连接重新发布模型能力。候选模型测试增加 `--keep-test-mode`，避免尚未验证的模型向正式告警队列写入内容。用 `camera_benchmark.py --port COM11 --seconds 120 --output local-camera-benchmark` 可测试真实相机，结束后保持检测暂停；验证完毕发送 `TEST_END` 恢复正式检测。

## 从源码构建

已验证组合：ESP-IDF 5.5.1、Arduino core 3.3.2、ESP-DL 3.3.14、esp_camera 2.1.3、esp_websocket_client 1.8.0、ArduinoJson 7.4.2、ArduinoWebsockets 0.5.4。`idf/main/idf_component.yml` 固定关键组件版本。

1. 准备上述官方依赖，在 Windows 安装相应 ESP-IDF 工具链。
2. 使用 `tools/prepare_idf.py --output 构建目录 --arduino-core Arduino源码目录 --libraries Arduino库目录` 在独立目录准备构建，不修改原始依赖目录。
3. 设置 `PG_ESPDL_DIR` 指向 ESP-DL 3.3.14，在生成的 `idf` 目录执行 `idf.py set-target esp32s3`、`idf.py build`。

运行时算子和内核列表由 `tools/compile_requirements.py` 按模型配置筛选，应用保持在原 2MB 分区以内。不要改成全量注册所有 ESP-DL 模型和算子后直接覆盖原分区布局。

原始权重、导出的 ONNX、INT8 模型、转换脚本和许可证来源随对应发行物提供。校准与回归视频包含用户画面，公开发行物仅包含汇总结果。
