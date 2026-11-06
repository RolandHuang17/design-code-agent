# v0.3.1 桌面验收记录

本轮重点是两个桌面程序的界面、生命周期与发布文件验收；历史实验未重跑，生成项目源码未人工修改。

- [构建来源与最终哈希](build-final.json)、[候选构建历史](build-attempts.json)、[回归历史](regression-history.json)
- [最终源码与隐私只读检查](independent-source-audit-final.json)、[12个布局场景](independent-layout.json)、[实际来宾输入法观察](independent-ime-guest.json)
- [环境清单](clean-windows/environment-final.txt)、[导入字节清单](clean-windows/import-manifest.json)
- [四个真实任务与宿主复验汇总](clean-windows/independent-runtime-summary.json)、[自带测试与构建完整结果](clean-windows/independent-host-checks.json)
- [主工具独立HTTP／重启](clean-windows/independent-main-health.json)、[原型独立HTTP／重启](clean-windows/independent-prototype-health.json)
- [离线审阅页](review.html)、[完整说明](../../docs/v031-validation.md)

`clean-windows/raw/main/generated`、`main/cancelled`、`prototype/recovered`、`prototype/cancelled`保留四个来宾任务的原始记录；名称表示操作谱系，不表示生成质量通过。精确来源目录、文件哈希和原报告状态见导入清单。

来宾没有Node，运行检查保持未验证。宿主复验：主工具自带4项测试、独立HTTP6项通过；原型独立HTTP6项通过，但自带1项测试因重复关闭服务器失败。该失败保留，不将角色审查批准等同于实际验证通过。

健康服务为小型机制演示，不是Space完整验收或普遍成功率实验。此前复杂项目的成功、失败与追加反馈仍见v0.3和v0.2原始记录。
