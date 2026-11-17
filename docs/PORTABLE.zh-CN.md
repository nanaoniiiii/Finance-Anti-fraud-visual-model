# Windows EXE 与 Linux 一键运行包

1.6.0 的两个 CPU 运行包均包含人体姿态与可选手机目标 ONNX 模型。Windows 无需另装 Python；Linux 安装脚本配置独立 Python、运行依赖、设备数据目录和 systemd 自启动服务。每台设备使用自己的绑定码和设备密钥，通过 HTTPS 域名连接云端，网络和 IP 改变不需要重新绑定。

## Windows 10/11 x64

解压 `PoseGuard-Windows-v1.6.0.zip`，双击 `PoseGuard.exe`。选择摄像头编号或本地视频，点击“开始检测”。关闭检测画面、按 Q / Esc 或点击“停止检测”都会结束检测并保留本地记录。

在网页或 App 的“设备与绑定”中选择 Windows，生成一次性绑定码，填入 EXE 的绑定框并绑定。摄像头识别联网后同步；选择本地视频时默认只保存本地记录。离线方向可选自动、0°、90°、180°、270°，联网摄像头也可以在网页和 App 调整。

本机配置和绑定保存在 `%LOCALAPPDATA%\PoseGuard`，检测记录位于其中的 `runs` 目录。升级时替换 EXE，保留此目录。发行包不包含任何设备密钥、管理员口令或用户视频。

命令行自检（会实际加载并运行两份模型）：

```powershell
.\PoseGuard.exe --self-test --output .\self-test
```

也可以用 `PoseGuard.exe --bind-code 一次性绑定码` 完成同一设备绑定流程，密钥仍只保存在本机私有目录。

源码构建请使用独立 Python 3.11 x64 环境，安装 `platforms/windows/requirements-build.txt`，导出模型后执行：

```powershell
python platforms/windows/collect_licenses.py --output licenses/windows-runtime
python platforms/windows/build.py --models D:\models --output D:\poseguard-build
```

EXE 没有 Windows 商业代码签名；Android APK 使用本项目原有签名，两者签名机制不同。

## Linux x86_64 / aarch64

适用于使用 glibc 和 systemd 的系统，如 Debian 12 或 Ubuntu。需要联网安装依赖，并具备 sudo 权限。RK3566 的原厂 Buildroot 系统请使用既有 RK3566 原生发行包，它的启动系统和 Python 依赖环境不同。

解压 `PoseGuard-Linux-v1.6.0.tar.gz`，进入解压目录，一条命令安装并启动摄像头 0：

```bash
sudo bash platforms/linux/install.sh --source 0 --bind-code 网页生成的Linux一次性绑定码
```

不填写绑定码也可以先离线运行；后续再执行同一安装命令并提供绑定码。正常升级不填写 `--bind-code`，保留原有设备身份和检测配置。安装器验证发行包内所有文件哈希；uv 引导器也校验固定版本的 SHA256。升级使用独立版本目录，配置失败会恢复原版本链接并重启此前正在运行的服务。

```bash
systemctl status poseguard
journalctl -u poseguard -f
sudo systemctl restart poseguard
```

安装后的路径：

| 内容 | 路径 |
| --- | --- |
| 当前程序 | `/opt/poseguard/current` |
| Python 环境 | `/opt/poseguard/venv` |
| 检测配置 | `/etc/poseguard/runtime.json` |
| 私有绑定 | `/var/lib/poseguard/device.private.json` |
| 本地事件、截图及待上传队列 | `/var/lib/poseguard/records` 及 `/var/lib/poseguard/cloud-data` |
| 启动记录 | `/var/lib/poseguard/records/service-starts.jsonl` |

服务使用独立 `poseguard` 系统用户并加入 `video` 组，不能读取普通用户家目录。需要测试视频时传 `--source /绝对路径/视频.mp4`，安装器将其复制到受保护的数据目录，默认仅本地检测。`--allow-test-video-cloud` 只接受云端明确标记为“联调设备”的绑定，用于隔离的端到端验证。

当前实际验证系统为全新 Debian 12 x86_64 虚拟机，已完成安装、真实视频推理、Linux 设备绑定、实际系统重启与服务自动运行。虚拟机使用软件 CPU 仿真，其耗时不能代表实体 Linux 电脑或 ARM 板性能。aarch64 是安装器支持的架构，未据此宣称已在所有 ARM64 发行版或摄像头上实测。
