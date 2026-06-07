import type { Context, Telegraf } from "telegraf";
import { isAuthorized } from "./auth";
import type { AppConfig } from "./config";
import type { ModelStore } from "./modelStore";
import { TaskStore } from "./taskStore";

export function registerCommandHandlers(
  bot: Telegraf,
  config: AppConfig,
  taskStore: TaskStore,
  modelStore: ModelStore,
): void {
  const helpText = buildHelpText();

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
    const workspaceExists = await pathExists(config.codexWorkspaceDir);
    const taskCount = await taskStore.countTasks(String(ctx.chat?.id ?? ""));
    const latestTask = await taskStore.getLatestTask(String(ctx.chat?.id ?? ""));

    await ctx.reply(
      [
        "Agent 状态：运行中",
        `RUN_CODEX_ENABLED：${String(config.runCodexEnabled)}`,
        `CODEX_WORKSPACE_DIR：${config.codexWorkspaceDir}`,
        `工作目录存在：${workspaceExists ? "是" : "否"}`,
        `当前群任务数量：${taskCount}`,
        latestTask
          ? `最近任务：${latestTask.fileName} (${latestTask.status})`
          : "最近任务：暂无",
      ].join("\n"),
    );
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
    "推荐直接说：",
    "· Codex，帮我实现登录页",
    "· Codex，先不要改代码，只分析方案",
    "· Codex，继续刚才那个任务",
    "",
    "也可以直接发文档/图片（在说明里 @我 或带上 Codex），我会下载下来读取。",
    "",
    "辅助命令：",
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
