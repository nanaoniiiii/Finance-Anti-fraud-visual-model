# PoseGuard 人体风险姿态预警原型

PoseGuard 是一个本地运行的多人姿态跟踪与疑似风险行为辅助预警程序。第一阶段仅识别三类行为：多人进入监控区、疑似持手机贴耳通话、长时间停留。红色框只表示需要人工关注，不代表身份、违法事实或诈骗结论。

## Windows 运行

```powershell
cd C:\Users\31919\Desktop\poseguard\.worktrees\human-risk-pose
python -m pip install -r requirements.txt
python -m poseguard.app --source 0 --config configs/windows.json
```

视频文件测试：

```powershell
python -m poseguard.app --source C:\path\to\test.mp4 --config configs/windows.json
```

按 `p` 暂停/继续，按 `q` 或 ESC 退出。默认事件写入 `runs/events.jsonl`，不保存原始视频、图片、人脸或完整关键点。

## 模型文件

Windows 原型默认读取：

- `models/yolo11n-pose.pt`：人体框与 17 个 COCO 关键点；
- `models/yolo11n.pt`：仅在出现贴耳候选姿态时检测 COCO `cell phone` 类别。

可以使用 `--disable-phone` 禁用手机实物检测；此时贴耳姿态只保持橙色候选，不升级为确认红色。

## 原创模块边界

模型只输出框、关键点和手机候选。稳定 ID、短时漏检保持、尺度归一化几何、时间窗口、滞回解除、风险融合、事件格式和界面由本工程独立实现。模型后端有明确接口，可替换为 RKNN、MaixPy/MaixCDK 或其他具备合适授权的运行时。

## 许可证提示

本工程不会把第三方代码或模型权重声明为原创。Ultralytics 提供 AGPL-3.0 与企业授权方案；闭源商业发布前必须结合最终模型权重、运行库和分发方式复核许可证。详见 `LICENSES.md`。
