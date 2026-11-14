# ESP32-S3 云端接入适配器

`PoseGuardCloud/` 是 Arduino ESP32-S3 接入示例，支持一次性绑定、HTTPS 心跳、橙色与红色风险累计、本地事件和目标截图、持久上报队列、重试及工作人员介入命令。本示例不包含 YOLO11n-Pose MCU 推理；把真实检测器或可信本地网关的结果输入适配器。

## 已构建配置

- Espressif Arduino Core 3.3.2，ArduinoJson 7.4.2。
- 目标 `esp32:esp32:esp32s3:PSRAM=opi,CDCOnBoot=cdc,USBMode=hwcdc,FlashSize=8M`，使用 8 MB Flash 和 8 MB OPI PSRAM。
- 程序约 1.10 MB，静态 RAM 47,836 字节。
- 示例不操作 GPIO 电机、继电器或蜂鸣器，不假设摄像头接线。
- HTTPS 校验使用 Google Trust Services Root R4，根证书来自 https://pki.goog/repository/ 。服务端更换证书颁发机构时应更新信任根。

## 构建

复制 `platforms/shared/incident_counter.hpp` 至 `PoseGuardCloud/incident_counter.hpp`，使共享计数规则与固件保持一致。安装上述 Core 和 ArduinoJson 后执行：

```powershell
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,CDCOnBoot=cdc,USBMode=hwcdc,FlashSize=8M" platforms/esp32s3/PoseGuardCloud
```

发布包同时提供应用、bootloader 和分区文件。烧录前确认芯片、Flash、PSRAM 和 USB 模式，并完整备份原有 Flash；不要把含 NVS/Wi-Fi 信息的原固件备份上传到公开仓库。不同硬件的 USB CDC、Flash 大小和 PSRAM 模式可能需要调整构建选项。

## 首次接入

连接串口 115200。若存储尚未初始化，设备会提示；确认原有数据已备份后，输入 `INIT_STORAGE` 初始化示例使用的 LittleFS 分区。

输入 `WIFI 网络名|密码` 保存网络配置并重启。网络连接后设备通过 NTP 获取时间，校准时间后才能验证 HTTPS 证书。串口不会回显保存的密码。

`STATUS` 会显示关联状态、断开原因和 IP 地址。若路由器提供 WPA2 密钥，可同样通过串口配置该网络的 64 位十六进制 PSK，并用 `WIFI_AP 网络名|PSK` 连接扫描到的最强同名接入点。PSK 与 Wi-Fi 密码同样需要私下保存。

在网页“设备与绑定”选择 ESP32-S3，生成一次性绑定码，然后在串口输入 `BIND 绑定码`。`STATUS` 可查看 Wi-Fi、存储和绑定状态。绑定后后台任务发送心跳并接收介入命令。

## 输入真实观测

```cpp
// riskKind: 1 疑似通话，2 多人，3 长时间停留
// state: 0 正常，1 橙色候选，2 红色确认
cloud.observe(trackId, riskKind, state, freshObservation,
              croppedJpegBytes, croppedJpegLength);
cloud.setHealth(detectorFps, personCount);
```

在同一实际图像帧内，每名人员每种风险只调用一次。预测补帧设置 `freshObservation=false`。目标裁剪 JPEG 可选，最大 60 KB；未提供截图时保留事件和累计记录。网络在独立任务中运行，推理循环调用 `localTick()` 处理结束状态。

默认第 101 个有效特殊帧首次上报；持续候选超过 300 帧升级为高风险，已确认风险超过 300 帧请求紧急介入。2 秒没有新的有效观测后结束事件。不同人员、不同风险分别累计。

本地文件包括 `/incidents.jsonl`、`/evidence/`、`/outbox/`、`/receipts.jsonl` 和 `/interventions.jsonl`。云端接受前不会删除待传事件。小容量 Flash 需定期归档本地证据并监测空间；不要直接删除尚未接受的 outbox 文件。

示例启动时只上报设备状态，不自动生成模拟风险。协议回归和实际 MCU 相机/模型验证分别记录，不能把编译成功当作识别效果实测。
