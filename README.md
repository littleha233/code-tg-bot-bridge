# tg-codex-agent

`tg-codex-agent` 是一个 Telegram + Codex 的自然语言项目助手。

你可以在私聊或群聊里像和同事协作一样对它说：

- `Codex，帮我实现登录页`
- `Codex1，你看下首页 UI 有没有问题`
- `帮我把这个需求整理成开发任务`
- `继续刚才那个任务`
- `先不要改代码，只分析一下方案`
- `执行一下测试，看看有没有报错`

第一版不接数据库，使用本地文件保存任务和日志。

## 功能概览

- 私聊中默认处理所有文本消息
- 群聊中只有包含 `Codex` / `codex` / `Codex1` / `Codex2` / `@bot` 才处理
- 支持自然语言身份查询、状态查询、任务记录、方案分析、开发执行、继续最近任务
- 默认 `RUN_CODEX_ENABLED=false`，先记录任务，不真正执行 `codex exec`
- 所有任务保存在 `tasks/`，所有执行日志保存在 `logs/`

## 项目结构

```text
tg-codex-agent/
  package.json
  tsconfig.json
  .gitignore
  .env.example
  README.md
  AGENTS.md
  src/
    index.ts
    config.ts
    auth.ts
    intentParser.ts
    taskStore.ts
    codexRunner.ts
    messageHandler.ts
    logger.ts
  tasks/
    .gitkeep
  logs/
    .gitkeep
```

## 如何安装依赖

```bash
npm install
```

## 如何配置 .env

1. 复制示例文件：

```bash
cp .env.example .env
```

2. 填入这些变量：

```bash
TELEGRAM_BOT_TOKEN=replace_me
TELEGRAM_ALLOWED_USER_IDS=123456789
TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890
RUN_CODEX_ENABLED=false
CODEX_WORKSPACE_DIR=/absolute/path/to/your/project
BOT_TRIGGER_NAMES=Codex,codex,Codex1,Codex2
TELEGRAM_PROXY_URL=http://127.0.0.1:7892
```

说明：

- `TELEGRAM_BOT_TOKEN` 只能从 `.env` 读取
- `TELEGRAM_ALLOWED_USER_IDS` 控制允许使用 bot 的用户
- `TELEGRAM_ALLOWED_CHAT_IDS` 控制允许使用 bot 的群或私聊 chat
- `RUN_CODEX_ENABLED=false` 时只记录任务，不真正调用 Codex
- `CODEX_WORKSPACE_DIR` 必须是允许 Codex 运行的项目目录
- 如果你在中国网络环境，建议显式配置 `TELEGRAM_PROXY_URL`

## 如何启动 bot

开发模式：

```bash
npm run dev
```

类型检查：

```bash
npm run typecheck
```

构建：

```bash
npm run build
```

生产启动：

```bash
npm start
```

## 如何把 bot 加入 Telegram 群

1. 打开 Telegram，搜索 `@BotFather`
2. 发送 `/newbot`
3. 创建机器人并拿到 bot token
4. 把 token 写入 `.env`
5. 将 bot 拉入目标群
6. 在群设置里关闭对 bot 的过度限制，保证它能读取普通消息
7. 把这个群的 `chat_id` 填入 `TELEGRAM_ALLOWED_CHAT_IDS`

## 如何获取 user_id 和 chat_id

先启动 bot，然后发这些自然语言：

- `我是谁`
- `查看我的 id`
- `当前群 id 是多少`

Bot 会回复：

- `user_id`
- `username`
- `chat_id`
- `chat_type`

把这些值写入 `.env` 的白名单字段即可。

## 如何开启自然语言触发

### 私聊

- 默认所有文本消息都会处理

### 群聊

- 只有消息包含 `Codex` / `codex` / `Codex1` / `Codex2` / `@bot` 时才处理
- 默认触发词来自 `BOT_TRIGGER_NAMES`

示例：

- `Codex，帮我实现登录页`
- `Codex1，分析一下这个方案`
- `@your_bot_username 继续刚才的任务`

### 辅助命令菜单

虽然主入口是自然语言，但 bot 也注册了一组轻量辅助命令：

- `/cxhelp`
- `/cxwhoami`
- `/cxstatus`
- `/cxrecent`

这些命令只做辅助，不会取代自然语言工作流。

## 如何开启 RUN_CODEX_ENABLED=true

默认：

```bash
RUN_CODEX_ENABLED=false
```

这时 bot 只会：

- 记录任务到 `tasks/`
- 回复任务摘要
- 不会真的调用 `codex exec`

开启真实执行时，改成：

```bash
RUN_CODEX_ENABLED=true
```

并确保：

- `codex` 已安装且可执行
- `CODEX_WORKSPACE_DIR` 指向允许操作的项目目录
- 对应用户和群都已在白名单中

## macOS 常驻运行

项目内置了 launchd 安装脚本：

```bash
npm run build
npm run launchd:install
launchctl unload ~/Library/LaunchAgents/com.nicola.tg-codex-agent.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.nicola.tg-codex-agent.plist
launchctl kickstart -k gui/$(id -u)/com.nicola.tg-codex-agent
```

launchd 日志位置：

- `logs/launchd.out.log`
- `logs/launchd.err.log`

## 常见测试语句

身份查询：

- `我是谁`
- `当前群 id 是多少`

状态查询：

- `现在状态怎么样`
- `Codex 现在能不能工作`
- `查看 agent 状态`

只记录任务：

- `Codex，帮我记录一个任务：实现登录页`
- `先把这个需求整理成任务，不要开发`

只分析不改代码：

- `Codex，分析一下这个功能怎么做，先不要改代码`
- `帮我拆解一下开发步骤`
- `执行一下测试，看看有没有报错`

允许开发：

- `Codex，帮我实现登录页`
- `Codex1，修复首页报错`
- `继续刚才那个任务，直接改代码`

## 安全说明

- `.env` 已加入 `.gitignore`
- `.env.example` 不包含真实 token
- 只有 `TELEGRAM_ALLOWED_USER_IDS` 和 `TELEGRAM_ALLOWED_CHAT_IDS` 白名单内的对象可用
- 不允许执行任意 shell 命令
- `codex exec` 只会在 `CODEX_WORKSPACE_DIR` 下运行
- 默认不会真正执行 Codex
- 日志中不会打印 token

## 验收要点

- `npm run typecheck` 通过
- `npm run dev` 能启动 bot
- 私聊可以自然语言交互
- 群聊必须命中触发词才处理
- `我是谁` 能返回 `user_id` 和 `chat_id`
- `Codex，帮我记录一个任务：xxx` 能创建任务文件
- `RUN_CODEX_ENABLED=false` 时不会真的调用 Codex
- `RUN_CODEX_ENABLED=true` 时可以调用 `codex exec`
- 日志保存到 `logs/`
