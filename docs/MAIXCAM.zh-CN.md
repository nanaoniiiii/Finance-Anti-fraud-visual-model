# MaixCAM 安装与使用

本包使用 MaixPy 4 的 YOLO11 INT8 姿态模型在板载 NPU 执行推理。实测设备是运行 MaixPy 4.12.5 的 RISC-V MaixCAM，模型输入为 320×224，原始摄像头画面为 320×240。使用板载模型 `/root/models/yolo11n_pose.mud` 和同目录的 `yolo11n-pose_320x224_int8.cvimodel`。[Sipeed 人体关键点模型说明](https://wiki.sipeed.com/maixpy/doc/en/vision/body_key_points.html)

1. 用 USB 连接 MaixCAM，确认电脑出现 USB 网络适配器。通过 SSH 连接板子。MaixCAM 的 USB 网关通常为 `10.243.64.1` 或 `10.243.65.1`，具体以本机分配为准。[Sipeed Linux 连接说明](https://wiki.sipeed.com/maixpy/doc/en/basic/linux_basic.html)
2. 使用 SCP 或 SFTP 把发布包上传到板上。确认系统已安装 MaixPy 4、板载 YOLO11n Pose 及 Python 的 `websocket-client`。
3. 在板上解压并安装。如需开机自启和云绑定，请先在管理台新增 MaixCAM 设备，准备一次性绑定码。

```sh
python3 -m tarfile -e PoseGuard-MaixCAM-v1.6.0.tar.gz
cd PoseGuard-MaixCAM-v1.6.0
python3 install.py --bind --autostart
sync
reboot
```

绑定码在提示处输入。仅在本机使用时执行 `python3 install.py`，并从板上应用列表打开 PoseGuard。联网后通过域名和设备凭据上报，IP 改变后继续使用原绑定。

更新时重新运行安装命令。已有设备去掉 `--bind`，安装器保留绑定和数据目录，使用新的版本目录，并备份更改前的 Launcher 和自启配置。安装时会显示备份目录。需要还原时，将该目录中 `maixapp/auto_start.txt` 和 `maixapp/apps/app.info` 复制回板上相应位置后重启。此前安装的程序和模型可继续从原路径访问。

在网页或 App 打开“实时预览”，可切换原始画面与“姿态与帧率”。在“安装检测方向”选择自动识别、0°、90°、180°、270°或水平镜像。设置在 NPU 推理前应用，并在设备端保存。两种显示使用同一次捕获的图像，姿态线由接收端绘制。

本地数据默认位于 `/root/poseguard-data/maix/`。状态文件记录应用是否已成功启动，`events.jsonl` 记录风险转换，`cloud-data/incidents.jsonl` 记录累计事件，`cloud-data/evidence/` 存放目标截图，`cloud-data/outbox/` 存放待确认记录。已经绑定的板子会在联网后继续上报。云端的人工作业状态由工作人员提交处置后更新。

在网页中核查设备状态和事件，也可在板上执行 `tail -n 20 /root/poseguard-data/maix/runtime.log` 查看相机和模型日志。实测数据见 [1.6.0 验收记录](edge-validation-2026-11-17.md)。
