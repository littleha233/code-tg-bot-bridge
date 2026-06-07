import { access } from "node:fs/promises";
import { message } from "telegraf/filters";
import { isAuthorized } from "./auth";
import type { AppConfig } from "./config";
import { CodexRunner } from "./codexRunner";
import { downloadTelegramFile } from "./fileDownload";
import { detectTrigger, parseIntent, type ParsedIntent } from "./intentParser";
import { createLogger } from "./logger";
import type { ModelStore } from "./modelStore";
import { TaskStore, type CodeChangePolicy, type TaskIntent } from "./taskStore";
import { splitMessageByLength, truncateText } from "./text";
import type { Telegraf, Context } from "telegraf";

const logger = createLogger("messageHandler");
const busyChats = new Set<string>();

interface BotContext extends Context {
  message: Context["message"] & { text: string };
}

export function registerMessageHandler(
  bot: Telegraf,
  config: AppConfig,
  taskStore: TaskStore,
  codexRunner: CodexRunner,
  botUsername: string | undefined,
  modelStore: ModelStore,
): void {
  bot.on(message("text"), async (ctx) => {
    await handleTextMessage(ctx as BotContext, config, taskStore, codexRunner, botUsername, modelStore);
  });

  // 文档 / 图片附件：下载到本机后把本地路径交给 codex 读取
  bot.on(message("document"), async (ctx) => {
    await handleAttachmentMessage(ctx, config, taskStore, codexRunner, botUsername, modelStore);
  });
  bot.on(message("photo"), async (ctx) => {
    await handleAttachmentMessage(ctx, config, taskStore, codexRunner, botUsername, modelStore);
  });
}

async function handleTextMessage(
  ctx: BotContext,
  config: AppConfig,
  taskStore: TaskStore,
  codexRunner: CodexRunner,
  botUsername: string | undefined,
  modelStore: ModelStore,
): Promise<void> {
  const text = ctx.message.text.trim();
  const chatType = ctx.chat?.type ?? "unknown";
  const userId = String(ctx.from?.id ?? "");
  const username = ctx.from?.username ?? ctx.from?.first_name ?? "unknown";
  const chatId = String(ctx.chat?.id ?? "");
  const replyToUsername = (ctx.message as { reply_to_message?: { from?: { username?: string } } })
    .reply_to_message?.from?.username;
  const isReplyToBot = Boolean(botUsername && replyToUsername === botUsername);

  const triggerMatch = detectTrigger(text, chatType, botUsername, config.botTriggerNames, isReplyToBot);
  if (!triggerMatch.shouldProcess) {
    return;
  }

  const intent = parseIntent(triggerMatch.cleanedText);

  logger.info("Incoming message", {
    userId,
    username,
    chatId,
    chatType,
    intent: intent.kind,
    summary: intent.summary,
  });

  if (intent.kind === "identity") {
    await replyLongMessage(ctx, buildIdentityReply(userId, username, chatId, chatType));
    return;
  }

  if (!isAuthorized(config, { userId, chatId })) {
    await replyLongMessage(
      ctx,
      "当前用户或群未加入白名单。先发送“我是谁”获取 user_id 和 chat_id，再把它们写入 .env。",
    );
    return;
  }

  if (intent.kind === "status") {
    await replyLongMessage(ctx, await buildStatusReply(config, taskStore));
    return;
  }

  if (intent.kind === "casual") {
    await replyLongMessage(
      ctx,
      "我在。如果你要我介入项目，可以直接说“Codex，帮我实现登录页”或“先不要改代码，只分析方案”。",
    );
    return;
  }

  if (intent.kind === "continue") {
    const recentTask = await taskStore.getLatestTask(chatId);
    if (!recentTask) {
      await replyLongMessage(
        ctx,
        "目前还没有最近任务可以继续。你可以先发一句“Codex，帮我记录一个任务：xxx”。",
      );
      return;
    }

    const inheritedIntent = overrideIntentForContinue(intent, recentTask.codeChangePolicy);
    await handleTaskIntent(ctx, config, taskStore, codexRunner, modelStore, inheritedIntent, {
      userId,
      username,
      chatId,
      chatType,
      relatedTaskId: recentTask.id,
      recentTaskContent: await taskStore.getLatestTaskContent(chatId),
    });
    return;
  }

  await handleTaskIntent(ctx, config, taskStore, codexRunner, modelStore, intent, {
    userId,
    username,
    chatId,
    chatType,
    relatedTaskId: undefined,
    recentTaskContent: undefined,
  });
}

async function handleTaskIntent(
  ctx: BotContext,
  config: AppConfig,
  taskStore: TaskStore,
  codexRunner: CodexRunner,
  modelStore: ModelStore,
  intent: ParsedIntent,
  context: {
    userId: string;
    username: string;
    chatId: string;
    chatType: string;
    relatedTaskId?: string;
    recentTaskContent?: string | null;
  },
): Promise<void> {
  if (busyChats.has(context.chatId)) {
    await replyLongMessage(ctx, "⏳ 这个群里上一个任务还在处理中，请稍候再发下一条。");
    return;
  }

  const prefix = intentToPrefix(intent.kind);
  const taskIntent = intentToTaskIntent(intent.kind);
  const task = await taskStore.createTask({
    prefix,
    intent: taskIntent,
    codeChangePolicy: intent.codeChangePolicy,
    summary: intent.summary,
    sourceText: intent.cleanedText,
    userId: context.userId,
    username: context.username,
    chatId: context.chatId,
    chatType: context.chatType,
    relatedTaskId: context.relatedTaskId,
  });

  if (intent.kind === "record") {
    task.status = "recorded";
    task.executionNotes = "仅记录任务，不调用 Codex。";
    await taskStore.updateTask(task);
    await replyLongMessage(ctx, `任务已记录。\n文件：${task.fileName}\n摘要：${task.summary}`);
    return;
  }

  if (!config.runCodexEnabled) {
    task.status = "recorded";
    task.executionNotes = "RUN_CODEX_ENABLED=false，本次仅记录任务，没有实际调用 Codex。";
    await taskStore.updateTask(task);
    await replyLongMessage(
      ctx,
      `任务已记录，但 Codex 执行未开启。\n文件：${task.fileName}\n模式：${intent.codeChangePolicy}\n摘要：${task.summary}`,
    );
    return;
  }

  task.status = "running";
  task.executionNotes = "Codex 执行中。";
  await taskStore.updateTask(task);
  busyChats.add(context.chatId);
  const ackMessage = await ctx.reply(`🐾 收到，正在处理…\n任务：${task.fileName}`).catch(() => null);
  await ctx.replyWithChatAction("typing").catch(() => {});
  const typingTimer = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 5000);

  try {
    const model = modelStore.get(context.chatId, config.codexModel);
    const result = await codexRunner.runTask(task, intent, context.recentTaskContent, model);
    task.status = result.ok ? "completed" : "failed";
    task.logPrefix = result.logPrefix;
    task.executionNotes = result.summary;
    await taskStore.updateTask(task);
    if (ackMessage) {
      await ctx.telegram.deleteMessage(Number(context.chatId), ackMessage.message_id).catch(() => {});
    }

    await replyLongMessage(
      ctx,
      [
        result.ok ? "Codex 已执行完成。" : "Codex 执行结束，但结果未完全成功。",
        `任务：${task.fileName}`,
        `日志前缀：${result.logPrefix}`,
        "",
        truncateText(result.summary, 3200),
      ].join("\n"),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    task.status = "failed";
    task.executionNotes = `执行异常：${message}`;
    await taskStore.updateTask(task);
    logger.error("Codex execution failed", { taskId: task.id, message });
    if (ackMessage) {
      await ctx.telegram.deleteMessage(Number(context.chatId), ackMessage.message_id).catch(() => {});
    }
    await replyLongMessage(ctx, `Codex 执行失败。\n任务：${task.fileName}\n错误：${message}`);
  } finally {
    clearInterval(typingTimer);
    busyChats.delete(context.chatId);
  }
}

async function handleAttachmentMessage(
  ctx: Context,
  config: AppConfig,
  taskStore: TaskStore,
  codexRunner: CodexRunner,
  botUsername: string | undefined,
  modelStore: ModelStore,
): Promise<void> {
  const msg = ctx.message as
    | {
        message_id: number;
        caption?: string;
        document?: { file_id: string; file_name?: string; mime_type?: string };
        photo?: Array<{ file_id: string }>;
        reply_to_message?: { from?: { username?: string } };
      }
    | undefined;
  if (!msg) {
    return;
  }

  const caption = (msg.caption ?? "").trim();
  const chatType = ctx.chat?.type ?? "unknown";
  const userId = String(ctx.from?.id ?? "");
  const username = ctx.from?.username ?? ctx.from?.first_name ?? "unknown";
  const chatId = String(ctx.chat?.id ?? "");
  const isReplyToBot = Boolean(botUsername && msg.reply_to_message?.from?.username === botUsername);

  const triggerMatch = detectTrigger(caption, chatType, botUsername, config.botTriggerNames, isReplyToBot);
  if (!triggerMatch.shouldProcess) {
    return; // 附件没 @我 / 没带触发词 / 不是回复我 → 不处理
  }

  if (!isAuthorized(config, { userId, chatId })) {
    await replyLongMessage(ctx as BotContext, "当前用户或群未加入白名单，无法处理附件。");
    return;
  }

  if (busyChats.has(chatId)) {
    await replyLongMessage(ctx as BotContext, "⏳ 这个群里上一个任务还在处理中，请稍候再发。");
    return;
  }

  let fileId: string;
  let fileName: string | undefined;
  let mime: string | undefined;
  if (msg.document) {
    fileId = msg.document.file_id;
    fileName = msg.document.file_name;
    mime = msg.document.mime_type;
  } else if (msg.photo && msg.photo.length > 0) {
    fileId = msg.photo[msg.photo.length - 1].file_id; // 取最大尺寸
    fileName = "photo.jpg";
    mime = "image/jpeg";
  } else {
    return;
  }

  const note = await ctx.reply("📎 收到附件，正在下载…").catch(() => null);
  let localPath: string;
  try {
    localPath = await downloadTelegramFile(
      ctx,
      fileId,
      fileName,
      config.telegramProxyUrl,
      config.downloadsDir,
    );
  } catch (error) {
    await replyLongMessage(
      ctx as BotContext,
      `下载附件失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  } finally {
    if (note) {
      await ctx.telegram.deleteMessage(Number(chatId), note.message_id).catch(() => {});
    }
  }

  logger.info("Downloaded attachment", { chatId, fileName, mime, localPath });

  const captionText = triggerMatch.cleanedText || "请读取并分析这个附件。";
  const intent = buildAttachmentIntent(captionText, localPath, fileName, mime);

  await handleTaskIntent(ctx as BotContext, config, taskStore, codexRunner, modelStore, intent, {
    userId,
    username,
    chatId,
    chatType,
    relatedTaskId: undefined,
    recentTaskContent: undefined,
  });
}

function buildAttachmentIntent(
  captionText: string,
  localPath: string,
  fileName: string | undefined,
  mime: string | undefined,
): ParsedIntent {
  const base = parseIntent(captionText);
  // 附件默认按“读取/分析”处理，不改代码；只有 caption 明确要求改代码才允许改
  let kind = base.kind;
  let codeChangePolicy = base.codeChangePolicy;
  if (kind !== "development" && kind !== "analysis") {
    kind = "analysis";
    codeChangePolicy = "no-change";
  } else if (kind === "analysis") {
    codeChangePolicy = "no-change";
  }

  const fileNote = [
    "",
    `[用户发来一个附件，已下载到本机绝对路径：${localPath}`,
    ` 文件名：${fileName ?? "(无)"}，类型：${mime ?? "(未知)"}]`,
    "请读取/分析该文件；若是 .docx/.doc/.xlsx/.pptx 等非纯文本，可用 macOS 自带 `textutil -convert txt -stdout <文件>` 等工具转换后读取。",
  ].join("\n");

  return {
    kind,
    codeChangePolicy,
    summary: truncateText(captionText.replace(/\s+/g, " ").trim() || "处理附件", 120),
    cleanedText: `${captionText}\n${fileNote}`,
    shouldCreateTask: true,
  };
}

async function buildStatusReply(config: AppConfig, taskStore: TaskStore): Promise<string> {
  const taskCount = await taskStore.countTasks();
  const latestTask = await taskStore.getLatestTask();
  const workspaceExists = await pathExists(config.codexWorkspaceDir);

  return [
    "Agent 状态：运行中",
    `RUN_CODEX_ENABLED：${String(config.runCodexEnabled)}`,
    `CODEX_WORKSPACE_DIR：${config.codexWorkspaceDir}`,
    `工作目录存在：${workspaceExists ? "是" : "否"}`,
    `当前任务数量：${taskCount}`,
    latestTask
      ? `最近任务：${latestTask.fileName} (${latestTask.status})`
      : "最近任务：暂无",
  ].join("\n");
}

function buildIdentityReply(
  userId: string,
  username: string,
  chatId: string,
  chatType: string,
): string {
  return [
    "身份信息如下：",
    `user_id: ${userId}`,
    `username: ${username}`,
    `chat_id: ${chatId}`,
    `chat_type: ${chatType}`,
  ].join("\n");
}

function overrideIntentForContinue(intent: ParsedIntent, recentPolicy: CodeChangePolicy): ParsedIntent {
  if (intent.codeChangePolicy === "allow-change" || intent.codeChangePolicy === "no-change") {
    return intent;
  }

  return {
    ...intent,
    codeChangePolicy: recentPolicy === "record-only" ? "no-change" : recentPolicy,
  };
}

function intentToPrefix(intentKind: ParsedIntent["kind"]): "TASK" | "ANALYZE" | "DEV" {
  if (intentKind === "record") {
    return "TASK";
  }

  if (intentKind === "analysis") {
    return "ANALYZE";
  }

  return "DEV";
}

function intentToTaskIntent(intentKind: ParsedIntent["kind"]): TaskIntent {
  if (intentKind === "record") {
    return "record";
  }

  if (intentKind === "analysis") {
    return "analysis";
  }

  if (intentKind === "continue") {
    return "continue";
  }

  return "development";
}

async function replyLongMessage(ctx: BotContext, text: string): Promise<void> {
  const chunks = splitMessageByLength(text, 3500);
  for (const chunk of chunks) {
    await ctx.reply(chunk, {
      reply_parameters: {
        message_id: ctx.message.message_id,
      },
    });
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
