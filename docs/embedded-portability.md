# 嵌入式迁移与后端接口说明

## 共同边界

嵌入式平台不重写风险业务层，只替换输入和推理适配：

- `PoseBackend.infer(frame)` 返回人体框、置信度和 17 个 COCO 关键点；
- `PhoneBackend.find(frame, regions)` 返回手机框和置信度；
- `types.py`、轨迹匹配、姿态几何、风险状态机、事件字段和规则测试保持一致；
- 无显示设备可关闭 `OverlayRenderer`，继续输出 JSONL 或串口/网络事件；
- 所有平台使用相同的黄色正常、橙色候选、红色确认语义。

## 泰山派 RK3566：主推理目标

泰山派官方资料中心提供 Linux/Buildroot、OpenCV 和 RKNN 示例入口，其中包含 RKNN-MobileNetV3 教程。Rockchip 官方 RKNN-Toolkit2 支持 RK3566/RK3568 系列，工作流是在电脑端转换模型为 RKNN，再由板端 RKNN Lite2 Python API 或 C/C++ Runtime 推理。Rockchip RK3566 brief datasheet 标注 NPU 为 1 TOPS@INT8。

迁移步骤：

1. Windows 原型模型导出为固定输入尺寸 ONNX；
2. 在受支持的 Ubuntu 环境使用 RKNN-Toolkit2 完成 INT8 校准和转换；
3. 对每层输出和最终 17 点解码做 ONNX/RKNN 数值对比；
4. 板端实现 `RknnPoseBackend`，输出当前工程的 `PersonObservation`；
5. 手机检测只在贴耳候选出现时运行，并允许降低到每 2～3 帧一次；
6. 记录输入尺寸、模型大小、NPU推理时间、CPU后处理时间、温度和连续运行稳定性。

推荐先测试 320 或 416 输入的轻量姿态模型。YOLO11n-pose 能否直接转换取决于导出图和当前 RKNN 算子支持；若转换失败，保持风险引擎不变，只替换为可稳定量化的轻量关键点模型。

官方资料：

- https://wiki.lckfb.com/zh-hans/tspi-rk3566/download-center.html
- https://github.com/airockchip/rknn-toolkit2/
- https://www.rock-chips.com/uploads/pdf/2022.8.26/191/RK3566%20Brief%20Datasheet.pdf

## MaixCAM Pro：独立轻量AI端

官方资料给出的核心资源为 SG2002、1GHz 主核、1 TOPS@INT8 NPU、256MB DDR3、最高 5MP 摄像头，以及 MaixPy/MaixCDK 软件栈。官方列举了 MobileNetV2、YOLOv5、YOLOv8 等常见模型算子，但没有据此保证 YOLO11n-pose 可直接运行。

迁移步骤：

1. 优先在 MaixPy/MaixCDK 的官方模型转换链中验证轻量姿态网络；
2. 若 YOLO11 姿态头不兼容，转换为设备已验证的检测/关键点结构；
3. 实现 `MaixPoseBackend`，将设备坐标、关键点置信度和人体框映射到统一记录；
4. 复用当前轨迹和风险引擎，按 256MB 内存限制缩小缓存、历史轨迹和输入尺寸；
5. 使用板载屏幕显示简化状态，或仅通过 Wi-Fi/UART 输出去身份化告警。

官方资料：https://wiki.sipeed.com/hardware/en/maixcam/maixcam_pro.html

## XIAO ESP32-S3 Sense：采集、预筛与联网告警

官方资料显示 XIAO ESP32-S3 Sense 使用最高 240MHz 的双核 Xtensa LX7，具有 8MB PSRAM、8MB Flash、OV3660 摄像头、数字麦克风和 SD 卡。它没有 RK3566/MaixCAM Pro 这一类独立 TOPS 级 NPU，因此第一阶段不承诺在该设备上实时运行完整 YOLO11n-pose。

适合的职责：

- 低分辨率摄像头采集和 JPEG 帧传输；
- 人员存在、区域占用或运动变化等 TinyML 预筛；
- 接收 RK3566/MaixCAM 的去身份化风险结果并驱动 LED、蜂鸣器或网络消息；
- 短时缓存事件片段，但默认不长期保存原始视频；
- 后续只有在独立测得内存、帧率和功耗合格时，才启用更小的关键点模型。

官方资料：https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/

## 下一阶段必须实测的指标

每个平台都记录同一组指标，避免只比较模型推理数字：

- 摄像头采集分辨率与实际帧率；
- 预处理、模型、后处理、轨迹和风险规则的分项耗时；
- 峰值内存、模型文件大小和连续运行温度；
- 目标短时遮挡后的 ID 恢复情况；
- 三类风险的触发延迟、解除延迟、误报和漏报样本；
- 断网状态、摄像头重连和异常退出后的资源释放情况。
