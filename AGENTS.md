# tg-codex-agent

本项目是一个 Telegram + Codex 的自然语言项目助手。

## 设计原则

- 群聊里只有被明确提及时才响应
- 默认只做任务记录，只有 `RUN_CODEX_ENABLED=true` 时才真的调用 `codex exec`
- 只允许在 `CODEX_WORKSPACE_DIR` 指定目录中运行 Codex
- 所有任务和执行日志都保存到本地文件

## Codex 执行约束

当 bot 调用 Codex 时，prompt 必须要求：

1. 先阅读 `README.md`、`AGENTS.md`、`package.json`
2. 先给出简短计划，再执行
3. 不扩大需求范围
4. 如果允许改代码，再做最小改动
5. 修改后运行可用的 `typecheck / lint / test / build`
6. 最终输出修改摘要、测试结果、风险
