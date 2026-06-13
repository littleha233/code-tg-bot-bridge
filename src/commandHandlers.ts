import type { Context, Telegraf } from "telegraf";
import { isAuthorized } from "./auth";
import { CodexRunner } from "./codexRunner";
import type { AppConfig } from "./config";
import type { ModelStore } from "./modelStore";
import type { SessionStore } from "./sessionStore";
import { TaskStore } from "./taskStore";
import { splitMessageByLength } from "./text";
import type { WorkspaceStore } from "./workspaceStore";

// 让 codex 把当前会话浓缩成上下文摘要
const COMPACT_PROMPT =
  "请把我们到目前为止的对话和你做过的工作，浓缩成一份简洁但完整的「上下文摘要」，" +
  "供开启新会话时作为背景。包含：核心目标/任务、关键决策与结论、当前进度与状态、" +
  "待办事项、涉及的重要文件与路径、需要遵守的约定。只输出摘要本身，不要寒暄或多余解释。";

export function registerCommandHandlers(
  bot: Telegraf,
  config: AppConfig,
  taskStore: TaskStore,
  modelStore: ModelStore,
  workspaceStore: WorkspaceStore,
  sessionStore: SessionStore,
  codexRunner: CodexRunner,
): void {
  const helpText = buildHelpText();

  bot.command("cxnew", async (ctx) => {
    const userId = String(ctx.from?.id ?? "");
    const chatId = String(ctx.chat?.id ?? "");
    if (!isAuthorized(config, { userId, chatId })) {
      return;
    }
    sessionStore.clear(chatId);
    await ctx.reply("🆕 已开启新会话，之前的对话上下文已清空。");
  });

  // /cxcompact：压缩上下文——生成摘要后清空长历史，摘要作为新会话背景
  bot.command("cxcompact", async (ctx) => {
    const userId = String(ctx.from?.id ?? "");
    const chatId = String(ctx.chat?.id ?? "");
    if (!isAuthorized(config, { userId, chatId })) {
      return;
    }
    const sessionId = sessionStore.get(chatId);
    if (!sessionId) {
      await ctx.reply("ℹ️ 当前没有进行中的会话，无需压缩（直接用 /cxnew 即可）。");
      return;
    }
    const note = await ctx.reply("🗜 正在压缩上下文（生成摘要中，可能要十几秒）…").catch(() => null);
    try {
      const result = await codexRunner.run({
        message: COMPACT_PROMPT,
        workspaceDir: workspaceStore.get(chatId, config.codexWorkspaceDir),
        model: modelStore.get(chatId, config.codexModel),
        sessionId,
        taskId: `COMPACT-${Date.now()}`,
      });
      if (note) {
        await ctx.telegram.deleteMessage(Number(chatId), note.message_id).catch(() => {});
      }
      if (!result.ok || !result.text.trim()) {
        await ctx.reply("❌ 生成摘要失败，请稍后再试。");
        return;
      }
      sessionStore.clear(chatId);
      sessionStore.setPendingSeed(chatId, result.text.trim());
      const reply = `✅ 已压缩上下文：旧的长历史已清空，下面这份摘要会作为新会话的背景。\n\n📋 摘要：\n${result.text.trim()}`;
      for (const chunk of splitMessageByLength(reply, 3500)) {
        await ctx.reply(chunk);
      }
    } catch (error) {
      if (note) {
        await ctx.telegram.deleteMessage(Number(chatId), note.message_id).catch(() => {});
      }
      await ctx.reply(`❌ 压缩失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  bot.command(["start", "cxhelp"], async (ctx) => {
    await ctx.reply(helpText);
  });

  bot.command("cxwhoami", async (ctx) => {
    const userId = String(ctx.from?.id ?? "");
    const username = ctx.from?.username ?? ctx.from?.first_name ?? "unknown";
    const chatId = String(ctx.chat?.id ?? "");
    const chatType = ctx.chat?.type ?? "unknown";

    await ctx.reply(
      [
        "身份信息如下：",
        `user_id: ${userId}`,
        `username: ${username}`,
        `chat_id: ${chatId}`,
        `chat_type: ${chatType}`,
      ].join("\n"),
    );
  });

  bot.command("cxstatus", async (ctx) => {
    const chatId = String(ctx.chat?.id ?? "");
    const workspaceDir = workspaceStore.get(chatId, config.codexWorkspaceDir);
    const workspaceExists = await pathExists(workspaceDir);
    const taskCount = await taskStore.countTasks(chatId);
    const latestTask = await taskStore.getLatestTask(chatId);
    const model = modelStore.get(chatId, config.codexModel) ?? "(codex 默认)";

    await ctx.reply(
      [
        "Agent 状态：运行中",
        `RUN_CODEX_ENABLED：${String(config.runCodexEnabled)}`,
        `当前工作目录：${workspaceDir}`,
        `工作目录存在：${workspaceExists ? "是" : "否"}`,
        `当前模型：${model}`,
        `当前群任务数量：${taskCount}`,
        latestTask
          ? `最近任务：${latestTask.fileName} (${latestTask.status})`
          : "最近任务：暂无",
      ].join("\n"),
    );
  });

  bot.command("cxproject", async (ctx) => {
    const userId = String(ctx.from?.id ?? "");
    const chatId = String(ctx.chat?.id ?? "");
    if (!isAuthorized(config, { userId, chatId })) {
      return;
    }

    const raw = "text" in (ctx.message ?? {}) ? (ctx.message as { text: string }).text : "";
    const arg = raw.replace(/^\/cxproject(@\S+)?/i, "").trim();

    if (!arg) {
      await ctx.reply(
        [
          `📁 当前工作目录：${workspaceStore.get(chatId, config.codexWorkspaceDir)}`,
          "",
          "切换：/cxproject ~/IdeaProjects/项目名",
        ].join("\n"),
      );
      return;
    }

    const result = workspaceStore.set(chatId, arg);
    if (!result.ok) {
      await ctx.reply(`❌ 切换失败：${result.error}\n你给的路径：${arg}`);
      return;
    }

    await ctx.reply(`📁 已切到：${result.path}\n下一条任务起我就在这个目录里干活。`);
  });

  bot.command("cxmodel", async (ctx) => {
    const userId = String(ctx.from?.id ?? "");
    const chatId = String(ctx.chat?.id ?? "");
    if (!isAuthorized(config, { userId, chatId })) {
      return;
    }

    const raw = "text" in (ctx.message ?? {}) ? (ctx.message as { text: string }).text : "";
    const arg = raw.replace(/^\/cxmodel(@\S+)?/i, "").trim();
    const current = modelStore.get(chatId, config.codexModel) ?? "(codex 默认模型)";

    if (!arg) {
      await ctx.reply(
        [
          `🧠 当前模型：${current}`,
          "",
          "切换：/cxmodel gpt-5-codex（或其它 codex 支持的模型名）",
          "恢复默认：/cxmodel default",
          "提示：模型名由 codex CLI 决定，填错下次执行会报错，可再用 /cxmodel default 改回。",
        ].join("\n"),
      );
      return;
    }

    if (arg.toLowerCase() === "default") {
      modelStore.set(chatId, "");
      await ctx.reply("🧠 已恢复为 codex 默认模型。下一条任务起生效。");
      return;
    }

    modelStore.set(chatId, arg);
    await ctx.reply(`🧠 已切换模型为：${arg}\n下一条任务起生效。`);
  });

  bot.command("cxrecent", async (ctx) => {
    const latestTask = await taskStore.getLatestTask(String(ctx.chat?.id ?? ""));
    if (!latestTask) {
      await ctx.reply("这个会话里还没有最近任务。");
      return;
    }

    await ctx.reply(
      [
        `最近任务：${latestTask.fileName}`,
        `状态：${latestTask.status}`,
        `类型：${latestTask.intent}`,
        `模式：${latestTask.codeChangePolicy}`,
        `摘要：${latestTask.summary}`,
      ].join("\n"),
    );
  });
}

export async function registerCommandMenu(bot: Telegraf): Promise<void> {
  await bot.telegram.setMyCommands([
    { command: "cxhelp", description: "查看自然语言用法和辅助命令" },
    { command: "cxnew", description: "清空对话上下文、开新会话" },
    { command: "cxcompact", description: "压缩上下文（生成摘要、省 token）" },
    { command: "cxproject", description: "切换工作目录；不带参数查看当前" },
    { command: "cxmodel", description: "切换 codex 模型；不带参数查看当前" },
    { command: "cxwhoami", description: "查看 user_id 和 chat_id" },
    { command: "cxstatus", description: "查看当前 agent 状态" },
    { command: "cxrecent", description: "查看当前群最近一个任务" },
  ]);
}

function buildHelpText(): string {
  return [
    "我是 Codex，可以在群里用自然语言协作。",
    "",
    "直接用自然语言说就行，我会记住上下文连续对话：",
    "· cx，帮我实现登录页",
    "· cx，先不要改代码，只分析一下这个模块",
    "· cx，刚才那个问题我已经改好了，你再看看",
    "",
    "也可以直接发文档/图片（在说明里 @我 或带上 cx），我会下载下来读取。",
    "",
    "辅助命令：",
    "· /cxnew 清空上下文、开新会话",
    "· /cxcompact 压缩上下文（生成摘要、省 token、保留主线）",
    "· /cxproject <路径> 切换工作目录；不带参数查看当前",
    "· /cxmodel <模型> 切换 codex 模型；不带参数查看当前",
    "· /cxwhoami 查看 user_id 和 chat_id",
    "· /cxstatus 查看当前状态",
    "· /cxrecent 查看当前群最近任务",
    "· /cxhelp 查看帮助",
  ].join("\n");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    const { access } = await import("node:fs/promises");
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
