# PoseGuard 多端云预警 1.2

管理地址：https://poseguard.nanaoni.tech

Windows、RK3566 与 MaixCAM 在本机推理并保存事件，云端负责设备管理、事件接收、通知和处置。ESP32-S3 提供设备接入及真实检测结果的上报适配器。安卓 APK 与 iPhone 主屏幕网页 App 使用同一工作区。

## 管理员与设备绑定

管理员初始口令由部署工具随机生成，私人凭据不进入仓库或发布包。首次登录后可在系统设置修改口令，在“通知与成员”中邀请工作人员。工作人员邮箱、通知订阅和设备均在同一工作区管理。

在“设备与绑定”中选择平台，生成有效期 10 分钟、仅可使用一次的绑定码。Windows、RK3566、MaixCAM 和 ESP32-S3 分别使用对应的接入程序领取自己的设备密钥。解除绑定会使原密钥失效。手机通过登录工作区、启用本机通知订阅并选择需要接收的设备完成关联。

设备密钥只允许调用设备接口，不能读取管理端、其他设备或私有截图。管理员口令、Gmail 应用专用密码、推送私钥和设备密钥不应提交到 GitHub。

## 累计、升级与本地证据

- 同一跟踪人员、同一风险分别累计橙色候选和红色确认状态。
- 只有本帧确实观测到的人员计数；预测补帧不计数。同一帧的一条风险只计一次。
- 累计到 100 帧仍不上传，第 **101 帧**首次上传。该门槛可以在系统设置调整。
- 101 帧的候选状态为“关注”，已出现确认状态为“高风险”。默认累计超过 300 帧后，持续候选升为“高风险”，已确认状态升为“紧急介入”。
- 短暂丢失保留事件；连续 2 秒没有该风险的有效观测后结束该事件。输入重置、摄像头断开、视频结束或程序退出会记录中断，避免把不同场景的人员累计到同一事件。
- 端侧保存开始、升级、结束或中断的 JSONL 记录；保存发生时间、跟踪编号、风险种类、累计帧数、级别和目标人员截图。发生时间与云端接收时间分别记录。
- RK3566 截图从绘制提示框前的原始图像裁剪，等比放入 320×320 图片；Windows 和 MaixCAM 保留目标裁剪。截图属于私有证据，需登录后访问。
- 端侧先写入本地持久队列，云端明确接受后才移除。事件 ID 加修订号用于重试去重；断网期间继续本地检测和记录。

RK3566 默认目录 `/userdata/poseguard/cloud-data`：

| 路径 | 内容 |
| --- | --- |
| `incidents.jsonl` | 本地事件及升级、结束记录 |
| `evidence/<事件ID>/` | 目标截图 |
| `state/` | 最近保存的累计状态 |
| `outbox/` | 等待云端接受的事件修订 |
| `receipts.jsonl` | 云端接受回执 |
| `interventions.jsonl` | 工作人员介入命令的本地记录 |
| `relay-status.json` | 最近云同步状态 |
| `rejected/` | 格式错误或被服务器永久拒绝的记录，保留供排查 |

事件在一个跟踪会话内累计，重启后以新的事件 ID 开始。尚未上传的持久队列会保留。保留截图会使用存储空间，应按现场要求定期归档本地记录；云端截图默认保留 7 天，可配置为 1～30 天。

## Windows

先按仓库首页完成 Python 依赖和模型初始化，再运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bind_windows_cloud.ps1
.\.venv\Scripts\python.exe -m poseguard.app --source 0 --cloud-config .secrets/windows-cloud.json
```

也可使用 `python -m poseguard.cloud.edge enroll --server https://poseguard.nanaoni.tech --code <绑定码> --platform windows --config .secrets/windows-cloud.json`。配置文件和本地数据位于 `.secrets/`，默认不会被 Git 跟踪。接入参数 `--cloud-config` 可用于本地视频和摄像头。

## RK3566

发布包包含原生 NPU 程序和独立的 Linux ARM64 网络中继。推理线程只处理检测和本地证据，网络连接在另一个进程运行。

板子已联网且时间正确时：

```sh
/userdata/poseguard/bin/poseguard-relay enroll \
  --server https://poseguard.nanaoni.tech --platform rk3566 \
  --code <绑定码> --config /userdata/poseguard/cloud.json
/etc/init.d/S99poseguardcloud start
/etc/init.d/S99poseguard status
```

`cloud.json` 需仅由 root 读取。默认配置会读取 `http://127.0.0.1:8081/status.json`，上报推理状态、帧率和人数。云端介入命令在本地写入并刷新到存储后才确认接收。

### 仅有 USB 调试线时

本次实测的 Buildroot ADB 不支持 `adb reverse`，因此提供使用 `adb forward` 的调试通道。电脑需要 Node.js、ADB 和互联网连接：

```powershell
adb -s <RK3566序列号> forward tcp:18444 tcp:18444
node agents/usb-bridge.mjs
```

另一个终端在板子绑定时添加 `--reverse-listen 127.0.0.1:18444`，例如：

```sh
/userdata/poseguard/bin/poseguard-relay enroll --code <绑定码> \
  --config /userdata/poseguard/cloud.json --reverse-listen 127.0.0.1:18444
```

这条通道只搬运 TCP 字节，HTTPS 的证书校验和设备认证仍由板子完成。电脑和调试线必须保持连接；它用于实验室联调。配好板子 Wi-Fi 后，使用 `poseguard-relay run --config /userdata/poseguard/cloud.json --direct` 验证独立联网，再从配置中删除 `reverse_listen` 并重启服务。

板子时间过旧会导致 TLS 证书验证失败。ADB 部署工具会校准时钟。独立运行应配置 Wi-Fi 开机连接和 RTC/NTP。已在泰山派 RK3566 上验证 2.4 GHz 路由器直连 HTTPS 云端心跳。

## MaixCAM

`platforms/maixcam/deploy.py` 会将共享传输模块一并上传为 `poseguard_cloud.py`。设备需有 Python 标准库 HTTPS 支持及可信 CA：

```sh
cd /root/poseguard_maix
python poseguard_cloud.py enroll --server https://poseguard.nanaoni.tech \
  --code <绑定码> --platform maixcam --config /root/poseguard_maix/cloud.json
python main.py --cloud-config /root/poseguard_maix/cloud.json
```

本版已做模块回归及传输协议验证，未连接 MaixCAM 做真实相机、裁剪与 HTTPS 联测。

## ESP32-S3

见 `platforms/esp32s3/README.zh-CN.md`。示例支持绑定、心跳、本地事件队列、HTTPS 上传和工作人员命令。把真实检测器的观测输入 `cloud.observe(...)`，并提供目标裁剪 JPEG。示例启动时只发送设备状态，不会自动生成风险事件。

ESP32-S3 的接入适配器不包含 YOLO11n-Pose 推理模型。可以由其他端通过现场可信链路提供检测结果，或另行接入适合该 MCU 的小模型。

## 手机接收与通知

安卓安装 `PoseGuard-Android.apk`。App 内置与网页相同的界面，登录、同步和读取私有截图使用安卓 HTTPS 网络接口。iPhone 在 Safari 打开管理地址，选择“分享 → 添加到主屏幕”，之后从主屏幕进入并启用通知。iPhone/iPad 网页推送需要 iOS/iPadOS 16.4 或更高版本。

在“通知与成员”中启用系统通知，再点接收终端旁的“配置”，选择全部设备或指定设备。浏览器前台通过 WebSocket 同步事件，断线时通过轮询补齐。安卓前台定期同步，后台由常驻服务接收并发布系统通知，常驻通知带有停止按钮。安卓发布系统通知后会向云端回执。网页和 iPhone 的后台提醒通过 Web Push 投递。

系统同时记录设备心跳中断和恢复。90 秒未收到心跳会判为离线，后台每 2 分钟检查一次并安排状态通知。

## 邮件

在系统设置填写 Gmail 发件邮箱、应用专用密码和收件地址，保存后发送测试邮件。密码经 AES-GCM 加密后存储；后台只返回“已设置”状态。不要使用日常登录密码。Gmail 应用专用密码需要启用两步验证，部分组织账号需由管理员允许。

邮件任务区分“待授权”“待发送”“发送中”“服务商已接受”和“失败”；“服务商已接受”不等于邮件已到收件箱。授权完成后可重试被阻塞的任务。本次用户选择稍后填写授权，因此没有声称真实邮件送达。

## 云端自行部署

`cloud/poseguard-hub` 使用 React、Cloudflare Workers、D1 和 Durable Objects。修改 `wrangler.jsonc` 的账户、D1 和自有子域名配置；创建数据库并执行远程迁移，再通过 `wrangler secret bulk` 配置 `OWNER_EMAIL`、PBKDF2 管理员口令哈希、32 字节 `ENCRYPTION_KEY` 和 VAPID 公私钥。不要在公开配置中填写口令或邮件授权码。

```sh
cd cloud/poseguard-hub
npm ci
npx wrangler d1 migrations apply poseguard-hub --remote
npm run deploy
```

Android 若由你重新签名，需要同步 `public/.well-known/assetlinks.json` 的签名 SHA-256 指纹。改动域名或签名后应重新做真机通知与关联测试。

回归测试设备显式标为测试设备，默认不发送外部通知。原始视频、可识别人像、设备密钥和管理员私人凭据不随公开发布包提供。
