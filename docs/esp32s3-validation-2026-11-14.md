# ESP32-S3 1.2.2 网络接入与恢复验证

此固件是检测结果接入与通知适配器，不包含 MCU 姿态模型。测试硬件为 ESP32-S3、8 MB Flash、8 MB OPI PSRAM，使用 Arduino ESP32 Core 3.3.2 和 ArduinoJson 7.4.2。

## 网络与绑定

- 使用普通 DHCP，实验中添加的路由器固定租约已撤销。
- 实机地址由一个 DHCP 地址变为另一个地址后，云端仍识别为原设备，手机接收范围仍按原设备 ID 生效。地址和 Wi-Fi 网络不参与设备授权。
- 设备主动连接 `https://poseguard.nanaoni.tech`，不要求入站端口或设备公网 IP。换 Wi-Fi 只需配置新网络名称和密码，保留云端设备密钥。
- 端侧先保存事件及目标截图、持久队列；服务器接受事件修订后才移出队列。协议用事件 ID 与修订号处理跨网络重试去重。

## 本版修复

1. 通过 IDF 停止尚在认证的连接尝试，避免重新配置时出现 `sta is connecting, cannot set config`。独立的 45 秒离线恢复流程重新应用已保存的配置。
2. 通过线程安全的 lwIP/BSD 接口解析服务器地址，避开实测回溯中的 `NetworkManager::hostByName -> dns_clear_cache -> sntp_dns_found -> udp_new_ip_type` 断言路径。
3. DNS 返回多个 IPv4 地址时，TLS 连接失败或 HTTP 读取超时后尝试其他地址；保持原域名的 SNI、证书和 CA 校验。每次请求使用独立 HTTPS 连接。
4. 提供持久化的 `TXPOWER AUTO`、`TXPOWER 8.5`、`TXPOWER 2`。当前实测板配置为 2 dBm，其他板默认 19.5 dBm。此设置与 IP 绑定无关，应按实际硬件和无线覆盖调试。

## 实测与检查

- 原有完整 Flash 已在升级前私下备份。升级写入 bootloader、分区和 app，不擦除设备绑定及事件分区。
- 用户对最终固件执行完全断电重插。开始监测时 Wi-Fi、时钟和原设备绑定均已恢复；随后 150.2 秒内记录到 3 次 HTTP 200、1 次读取超时，超时后约 5.9 秒恢复成功。采样中距最近一次成功心跳最大 60 秒，Wi-Fi 持续连接，重连计数为零。没有再次输入 Wi-Fi 或绑定码。
- 网络观察中实际出现过 HTTP 读取超时并自动恢复，不能将本次功能验证解释为网络零故障或固定送达时延。原始串口观测及错误记录保留在私有工作目录。
- 新增 6 项主机回归，使用 AddressSanitizer 与 UndefinedBehaviorSanitizer，覆盖缓存地址跟踪、HTTP 超时后切换、TLS 失败后切换、截断 DNS、事务 ID 不匹配，以及不调用旧 hostname 解析路径。实际 TLS 与 Wi-Fi 另在设备上验证。
- 真实 Worker/D1 的 6 项测试全部通过且无跳过，包含同一设备密钥跨来源 IP 上报、101 帧门槛、重试去重、私有截图、升级及手机回执。
- 安卓后台测试消息的对应序号为 80。云端发出到手机发布回执为 4.426 秒，同时在 Android 系统通知管理器中找到对应通知。此结果表示系统发布，不能代表用户已阅读。

```text
app bytes: 1108656
app SHA-256: afce1fd6b42ad20d34f1b07d9ce136749a25b4860a2b6635c19fbf8e35666b32
```

完整 RK3566、安卓、Windows 与 MaixCAM 交付见 [PoseGuard 1.2.0](https://github.com/nanaoniiiii/Finance-Anti-fraud-visual-model/releases/tag/poseguard-v1.2.0) 和 [多端使用指南](CLOUD.zh-CN.md)。MaixCAM 与 iPhone 真机联调、Gmail 实际投递仍按总验证记录的边界处理。
