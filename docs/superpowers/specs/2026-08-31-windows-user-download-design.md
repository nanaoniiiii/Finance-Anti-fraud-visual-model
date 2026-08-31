# PoseGuard Windows 普通用户下载与运行设计

## 目标

让没有 Git 和 Python 项目经验的 Windows 用户能够从 GitHub 下载 PoseGuard，按明确步骤完成首次初始化，并使用 USB 或内置摄像头启动程序。

## 用户入口

README 项目介绍之后增加“普通用户快速开始”章节，优先说明 GitHub Releases 下载方式，同时保留 `Code -> Download ZIP` 源码下载方式。嵌入式设备部署继续放在后续开发者章节，不混入普通用户流程。

## 文件与流程

- `setup_windows.bat`：首次运行。检查 Python 3.11，创建 `.venv`，安装 `requirements.txt`，在 `models` 目录获取 `yolo11n-pose.pt` 和 `yolo11n.pt`。
- `run_windows.bat`：日常运行。检查虚拟环境和模型是否存在，然后使用默认摄像头启动 PoseGuard。
- README 手动流程：提供与脚本等价的 PowerShell 命令，便于排错和高级用户使用。

普通用户流程为：下载 ZIP、解压、运行初始化脚本、运行启动脚本。程序窗口中按 `p` 暂停或继续，按 `q` 或 `Esc` 退出。

## 模型处理

Release 不直接声明第三方模型为项目原创，也不把模型权重纳入 Git 历史。初始化脚本通过已安装的 Ultralytics 运行库获取官方模型，并将权重保存在本地 `models` 目录。README 保留许可证提示。

## 错误提示

脚本针对以下情况给出中文提示并返回非零退出码：

- 未安装 Python 3.11；
- 虚拟环境创建或依赖安装失败；
- 模型获取失败；
- 未执行初始化便直接启动；
- 模型文件缺失。

摄像头不可用和 CPU 推理较慢的排查方式写入 README，不在启动脚本中隐藏程序原始错误。

## 验证

- 批处理脚本执行基本语法和路径检查；
- 在现有环境运行项目测试；
- 使用 README 中的手动命令验证入口参数；
- 检查 README 中不存在尚未创建的固定 Release 资源文件链接。
