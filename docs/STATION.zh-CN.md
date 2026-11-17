# 网点边端、语音联动与云端工作区

设备接到网点边端。边端接收视觉设备事件、离线语音识别证据和交易系统信号，确定现场风险级别，保留本地记录，并发出弹窗或工作人员介入请求。云端按工作区接收边端已判断的事件、设备和人员归档，用于查询和统计。已有直连设备仍可使用原主工作区，完成现场边端验证后再逐台改绑。

## 启动本网点边端

以下方式已在 Node.js 24 的 Windows 环境验证。安装 Python 3.11 和语音依赖仅供需要语音检测的机器使用。项目使用相同的 Worker 逻辑和本地持久数据库运行边端，同一台网点机器即可打开设备、事件、个人消息、通知、邮件配置和人工处置页面。浏览器通过该网点地址访问，可添加至主屏幕。浏览器后台推送和 SMTP 取决于该网点的通知服务配置。

```powershell
Copy-Item platforms/edge/station.example.json D:/PoseGuard/station.json
cd cloud/poseguard-hub
npm ci
npm run build
$env:POSEGUARD_STATION_SETUP_PASSWORD = Read-Host '设置边端口令（至少 12 位）'
node edge/run.mjs D:/PoseGuard/station.json --init
```

配置文件中的 `admin_email` 是该网点管理员的账号。启动后可清除当前终端的初始化变量。以后直接运行同一命令去掉 `--init`，会复用本地账号、事件和设备绑定。现场设备从其他机器访问时，在配置中填写局域网监听地址、HTTPS 地址以及 `tls.certificate`、`tls.key`，设备和浏览器须信任该证书。仅同机联调使用 `http://127.0.0.1:8790`。数据目录由 `data_dir` 指定，包含持久事件和账号配置。

手机可以将网点 HTTPS 页面添加到主屏幕，进入该网点工作台。当前原生 Android 安装包连接云端工作区。网点测试通过前可继续使用已有云端绑定。重新绑定 Windows、RK3566、Linux 或 MaixCAM 时，在边端生成对应设备类型的绑定码，将部署配置中的服务地址改为网点 HTTPS 地址。

## 检测点与归档

1. 在边端绑定视觉终端和语音检测端。在每台设备详情设置融合检测点编号，例如 `ATM-01`。只有相同检测点的近期证据会相互关联。测试设备独立于正式设备计算。
2. 在云端打开左侧工作区下拉并新增网点。进入「平台管理」，通过「设备总览与管理」生成边端接入配置。将其中的 `archive` 对象写入本网点配置。云端会将归档写入该边端所绑定的工作区。
3. 左上入口查询所有归档事件，右上风险分布可切换逐月、逐日、逐小时。柱子按紧急、高风险、关注从深红过渡到粉色和近白色。时间使用北京时间。左下查询设备和管理边端接入，右下管理云端查看权限并查询网点人员。
4. 归档连接中断时保留未确认队列，恢复后继续同步。告警和人工处置在本网点继续运行。需要同步视觉事件截图时在 `archive` 中设置 `"include_snapshots": true`。归档只带风险证据的类别和处置数据。音频和转写内容仅在本机识别时暂存于内存。

## 第一版语音证据

```powershell
python -m pip install -r platforms/edge/requirements-speech.txt
python platforms/edge/download-voice-model.py D:/PoseGuard/models/whisper-base
& .\platforms\edge\generate-demo-voice.ps1 -OutputDirectory D:/PoseGuard/demo
python -m poseguard.speech_agent --model D:/PoseGuard/models/whisper-base --play-test D:/PoseGuard/demo/risk-code-demo.wav
```

在边端生成「语音检测」绑定码后，可用 `python -m poseguard.cloud.edge enroll --platform speech --server <边端地址> --code <绑定码> --config <绑定文件>` 建立语音终端绑定。运行 `python -m poseguard.speech_agent --model <模型目录> --binding <绑定文件> --mic`，按需用 `--input-device` 选择麦克风。对照样例可用 `--wav` 输入文件，`--play-test` 会播放样例并从输入设备采样。测试输出只有证据编号、置信度和耗时。

接入 MaixCAM 板载麦克风时，可在本网点通过已授权的 SSH 连接将原始 PCM 送给边端语音进程。以下命令使用 Linux Shell 或支持原生程序之间传输二进制管道的 PowerShell 7.4 及以上版本。示例中的 SSH 主机名、模型和绑定文件路径按各网点替换。 [MaixCAM 音频采集说明](https://wiki.sipeed.com/maixpy/doc/zh/audio/record.html) · [PowerShell 二进制管道说明](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_redirection#example-7-redirecting-binary-data-from-a-native-command)

```bash
ssh -T root@maixcam.local 'arecord -q -D hw:0,0 -c 1 -r 16000 -f S16_LE -t raw' | python -m poseguard.speech_agent --model ./whisper-base --binding ./speech-binding.json --pcm-stdin
```

MaixCAM 读取麦克风并向本网点传输音频流。边端在内存里分段并离线识别，后续归档传输风险证据类别。

语音模型使用 Whisper Base 在本机以 CPU INT8 运行，后续可在本网点接入更完整的语言模型。首版关注索要或汇报验证码及密码、引导屏幕共享、要求转入所谓安全账户、冒充机构伴随威胁或保密要求。普通通话提示只作背景线索，带保护语义的安全提醒不会进入相应风险类别。交易系统可绑定为交易信号源并送入陌生收款方、短时重复转账等结构化证据。

边端融合采用当前检测点约 90 秒内的证据，同一证据类型重复出现仅保留最强观测。融合告警用于请求现场核查，人工作业的状态和时间随事件归档。转写依赖现场麦克风、噪声和说话方式。先在对应网点验证正常操作和异常样例，再启用日常采集。

视觉终端短时比边端快至多 30 秒时，融合按边端接收时间计入该信号。超过融合窗口的历史视觉事件仍可归档。

## ESP32-S3 网点固件

使用 [ESP32-S3 构建说明](../platforms/esp32s3/README.zh-CN.md) 中的 IDF 部署流程。在 `prepare_idf.py` 预备构建目录时增加 `--station-origin https://station.example:8790 --station-ca <网点 CA 的 PEM 文件>`。在网点设备页生成 ESP32-S3 绑定码，通过 USB 执行 `BIND`。同一设备的网点绑定、待传队列、截图和处置日志按网点地址保存到独立路径。保留原 NVS 和 LittleFS 分区即可用原固件继续使用原云端绑定。

网点 CA 签发的服务证书需与网点域名匹配，并能被设备在局域网内解析。边端使用私有 CA 时，在启动 Node.js 服务前将 CA 的文件路径设为 `NODE_EXTRA_CA_CERTS`，使本地归档调度进程能够验证 HTTPS。
