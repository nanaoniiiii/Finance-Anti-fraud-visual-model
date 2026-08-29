# 嵌入式迁移与后端接口说明

## 共同产品边界

泰山派 RK3566、MaixCAM Pro 和 XIAO ESP32-S3 Sense 是三个互不依赖的端侧版本。每个版本都必须在本机完成以下闭环：

```text
本机摄像头 -> 本机姿态/手机推理 -> 本机多人跟踪 -> 本机风险规则 -> 本机告警输出
```

设备之间不传递待推理图像，也不要求某一设备接收另一设备的推理结果。可复用的业务语义如下：

- `PoseBackend.infer(frame)` 返回人体框、置信度和 17 个 COCO 关键点；
- `PhoneBackend.find(frame, regions)` 返回手机框和置信度；
- `types.py`、轨迹匹配、姿态几何、风险状态机、事件字段和规则测试保持一致；
- 无显示设备可关闭 `OverlayRenderer`，继续输出 JSONL 或串口/网络事件；
- 所有平台使用相同的黄色正常、橙色候选、红色确认语义。

不同平台不必共享同一个模型二进制文件。受语言和内存限制时，轨迹与规则可以等价重写，但必须使用相同的合成输入向量验证三类风险的触发和解除语义。

## 泰山派 RK3566：USB 摄像头独立版本

泰山派官方资料中心提供 Linux/Buildroot、OpenCV 和 RKNN 示例入口，其中包含 RKNN-MobileNetV3 教程。Rockchip 官方 RKNN-Toolkit2 支持 RK3566/RK3568 系列，工作流是在电脑端转换模型为 RKNN，再由板端 RKNN Lite2 Python API 或 C/C++ Runtime 推理。Rockchip RK3566 brief datasheet 标注 NPU 为 1 TOPS@INT8。

迁移步骤：

1. Windows 原型模型导出为固定输入尺寸 ONNX；
2. 在受支持的 Ubuntu 环境使用 RKNN-Toolkit2 完成 INT8 校准和转换；
3. 对每层输出和最终 17 点解码做 ONNX/RKNN 数值对比；
4. 板端实现 `RknnPoseBackend`，输出当前工程的 `PersonObservation`；
5. 手机检测只在贴耳候选出现时运行，并允许降低到每 2～3 帧一次；
6. 在 RK3566 本机运行轨迹管理、风险状态机以及 GPIO、串口或网络告警；
7. 记录输入尺寸、模型大小、NPU推理时间、CPU后处理时间、温度和连续运行稳定性。

摄像头固定采用 USB UVC 设备，板端需要处理设备号变化、MJPG/YUYV 协商、缓冲区积压和断开重连。推荐先测试 320 或 416 输入的轻量姿态模型。YOLO11n-pose 能否直接转换取决于导出图和当前 RKNN 算子支持；若转换失败，保持风险引擎不变，只替换为可稳定量化的轻量关键点模型。

官方资料：

- https://wiki.lckfb.com/zh-hans/tspi-rk3566/download-center.html
- https://github.com/airockchip/rknn-toolkit2/
- https://www.rock-chips.com/uploads/pdf/2022.8.26/191/RK3566%20Brief%20Datasheet.pdf

## MaixCAM Pro：板载摄像头独立版本

官方资料给出的核心资源为 SG2002、1GHz 主核、1 TOPS@INT8 NPU、256MB DDR3、最高 5MP 摄像头，以及 MaixPy/MaixCDK 软件栈。官方列举了 MobileNetV2、YOLOv5、YOLOv8 等常见模型算子，但没有据此保证 YOLO11n-pose 可直接运行。

迁移步骤：

1. 优先在 MaixPy/MaixCDK 的官方模型转换链中验证轻量姿态网络；
2. 若 YOLO11 姿态头不兼容，转换为设备已验证的检测/关键点结构；
3. 实现 `MaixPoseBackend`，将设备坐标、关键点置信度和人体框映射到统一记录；
4. 复用当前轨迹和风险引擎，按 256MB 内存限制缩小缓存、历史轨迹和输入尺寸；
5. 在设备本机完成条件式手机确认、三类风险判断和事件去抖；
6. 使用板载屏幕显示简化状态，或通过 Wi-Fi/UART 输出去身份化告警。

该版本直接使用 MaixCAM Pro 板载摄像头，不依赖 RK3566、Windows 主机或外接视频服务器。YOLO11 姿态头的转换兼容性必须以实机模型加载、算子执行和关键点数值对比为准。

官方资料：https://wiki.sipeed.com/hardware/en/maixcam/maixcam_pro.html

## XIAO ESP32-S3 Sense：板载摄像头独立 TinyML 版本

官方资料显示 XIAO ESP32-S3 Sense 使用最高 240MHz 的双核 Xtensa LX7，具有 8MB PSRAM、8MB Flash、OV3660 摄像头、数字麦克风和 SD 卡。它没有 RK3566/MaixCAM Pro 这一类独立 TOPS 级 NPU，因此不能直接复制完整 YOLO11n-pose 链路，但仍需作为独立端侧终端完成全部风险处理。

独立实现路径：

1. 使用板载 OV3660 采集低分辨率 RGB 或灰度图，优先选择不会挤占推理工作区的帧缓存方案；
2. 训练专用的少关键点姿态网络，通过蒸馏、通道剪枝和 INT8 量化压缩到设备可承受范围；
3. 将完整 17 点规则映射为少关键点版本所需的耳、腕、肩、髋和脚部证据；若模型点位更少，则重新训练对应点位，不能用不存在的点进行推断；
4. 对贴耳候选区域运行小型手机/手部局部分类器，或采用联合多任务输出完成手机确认；
5. 使用定长数组维护少量轨迹和计时器，在设备本机完成多人、贴耳通话和长时间停留判断；
6. 由设备本机驱动 LED、蜂鸣器或 Wi-Fi 告警，断网时仍能本地工作；
7. 默认只记录去身份化事件，不长期保存原始图像。

该版本不是采集前端、转发节点或其他板卡的附属设备。若实测资源不足，应继续缩小输入、关键点数量、最大跟踪人数和模型宽度，而不是把核心推理转移给另外两台目标设备。

官方资料：https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/

## 下一阶段必须实测的指标

每个平台都记录同一组指标，避免只比较模型推理数字：

- 摄像头采集分辨率与实际帧率；
- 预处理、模型、后处理、轨迹和风险规则的分项耗时；
- 峰值内存、模型文件大小和连续运行温度；
- 目标短时遮挡后的 ID 恢复情况；
- 三类风险的触发延迟、解除延迟、误报和漏报样本；
- 断网状态、摄像头重连和异常退出后的资源释放情况。

验收时三台设备分别断开其他计算设备独立运行；从摄像头画面到风险告警的完整链路均不得依赖局域网推理服务。
