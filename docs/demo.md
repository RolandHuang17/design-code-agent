# 操作示例与录像

## 输入解析与小任务生成

1. 解压 Windows 发布包，双击 `DesignCodeAgent.exe`。选择百炼并填写匹配地域的兼容地址及 API Key，型号选 `deepseek-v4-pro-0813`。输入法先切换英文，推荐粘贴或读取环境变量。
2. 选择原始两份架构材料，点击“解析预览”。当前输入应显示13个图代码块和1条可用性指标冲突。
3. 首次验证工具链可改用随包 `examples/smoke` 下的两份文档，选择 `generic-node`、0轮修复和独立输出目录，再启动生成。连接和生成会产生模型调用费用。
4. 自动检查需要相应运行环境与执行授权；缺少 Node/npm 或 Docker 的检查标记为 `unverified`。桌面工具无需预装 Python，生成项目仍需各自运行环境。
5. 通过“打开结果目录”查看 `inputs`、`project` 和 `artifacts`。取消任务会保留已经落盘的文件、报告和不确定费用预留。

## 检查生成结果

`plan.json` 给出生成任务；`events.jsonl` 记录工具调用与结果；`checks-*.json` 保留各轮检查；`revisions` 保存文件修改快照。最终状态由宿主检查计算。项目自带测试、独立HTTP检查、浏览器检查和未验证项分别记录。

Space Fractions 的外部HTTP验收入口为 `scripts/evaluate_project.py`。服务启动并取得三个不同权限或身份的OIDC access token后，配置 `SPACE_USER_TOKEN`、`SPACE_ADMIN_TOKEN`、`SPACE_OTHER_USER_TOKEN`，再运行：

```powershell
python scripts/evaluate_project.py --base-url http://127.0.0.1:3000
```

脚本验证权限、暂停、非法分数、计分和重复提交，会创建并清理一条测试题目。重启持久化和浏览器流程另外验证，结果见各案例报告。

## 已记录的操作录像

- [v0.1桌面操作截图回顾](media/desktop-demo.mp4)：9秒，来自真实exe操作截图，展示中文/空格路径解析和0813连接；不属于完整生成录屏。
- [v0.1游戏流程](media/game-full-flow.mp4)：约81秒，由162秒原始浏览器录像按2倍速播放，包含登录、答题推进和10/10结束反馈。对应经过操作者修正的交付副本，来源与修改清单见 [案例报告](../examples/space-fractions/README.md)。
- [v0.2借阅反馈修复](media/library-feedback-demo-v02.mp4)：约1分钟，对应开发期Agent续跑。剪辑、加速与原始文件哈希见 [录像来源记录](../experiments/v02/development/video-provenance.json)。该续跑不计入正式九次的新生成成功数。

正式借阅案例的额外浏览器检查使用截图和独立HTTP报告，见 [实验结果](v02-results.md)。最终桌面程序的独立系统验收见 [干净Windows记录](clean-windows.md)。
