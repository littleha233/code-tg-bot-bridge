import { message } from "telegraf/filters";
import { isAuthorized } from "./auth";
import type { AppConfig } from "./config";
import { CodexRunner } from "./codexRunner";
import { downloadTelegramFile } from "./fileDownload";
import { detectTrigger } from "./intentParser";
import { createLogger } from "./logger";
import type { ModelStore } from "./modelStore";
import type { SessionStore } from "./sessionStore";
import { TaskStore } from "./taskStore";
import { splitMessageByLength, truncateText } from "./text";
import type { WorkspaceStore } from "./workspaceStore";
import type { Telegraf, Context } from "telegraf";

const logger = createLogger("messageHandler");
const busyChats = new Set<string>();

interface Deps {
  config: AppConfig;
  taskStore: TaskStore;
  codexRunner: CodexRunner;
  botUsername: string | undefined;
  modelStore: ModelStore;
  workspaceStore: WorkspaceStore;
  sessionStore: SessionStore;
}

interface ChatInfo {
  userId: string;
  username: string;
  chatId: string;
  chatType: string;
}

export function registerMessageHandler(
  bot: Telegraf,
  config: AppConfig,
  taskStore: TaskStore,
  codexRunner: CodexRunner,
  botUsername: string | undefined,
  modelStore: ModelStore,
  workspaceStore: WorkspaceStore,
  sessionStore: SessionStore,
): void {
  const deps: Deps = {
    config,
    taskStore,
    codexRunner,
    botUsername,
    modelStore,
    workspaceStore,
    sessionStore,
  };

  bot.on(message("text"), async (ctx) => {
    await handleText(ctx, deps);
  });
  bot.on(message("document"), async (ctx) => {
    await handleAttachment(ctx, deps);
  });
  bot.on(message("photo"), async (ctx) => {
    await handleAttachment(ctx, deps);
  });
}

function readInfo(ctx: Context): ChatInfo {
  return {
    userId: String(ctx.from?.id ?? ""),
    username: ctx.from?.username ?? ctx.from?.first_name ?? "unknown",
    chatId: String(ctx.chat?.id ?? ""),
    chatType: ctx.chat?.type ?? "unknown",
  };
}

function isReplyToBot(ctx: Context, botUsername: string | undefined): boolean {
  const replyTo = (ctx.message as { reply_to_message?: { from?: { username?: string } } } | undefined)
    ?.reply_to_message?.from?.username;
  return Boolean(botUsername && replyTo === botUsername);
}

async function handleText(ctx: Context, deps: Deps): Promise<void> {
  const text = ((ctx.message as { text?: string } | undefined)?.text ?? "").trim();
  const info = readInfo(ctx);
  const trigger = detectTrigger(
    text,
    info.chatType,
    deps.botUsername,
    deps.config.botTriggerNames,
    isReplyToBot(ctx, deps.botUsername),
  );
  if (!trigger.shouldProcess) {
    return; // 不是在叫 cx，忽略
  }
  await processCodexMessage(ctx, deps, info, trigger.cleanedText);
}

async function handleAttachment(ctx: Context, deps: Deps): Promise<void> {
  const msg = ctx.message as
    | {
        message_id: number;
        caption?: string;
        document?: { file_id: string; file_name?: string; mime_type?: string };
        photo?: Array<{ file_id: string }>;
      }
    | undefined;
  if (!msg) {
    return;
  }

  const caption = (msg.caption ?? "").trim();
  const info = readInfo(ctx);
  const trigger = detectTrigger(
    caption,
    info.chatType,
    deps.botUsername,
    deps.config.botTriggerNames,
    isReplyToBot(ctx, deps.botUsername),
  );
  if (!trigger.shouldProcess) {
    return;
  }

  if (!isAuthorized(deps.config, { userId: info.userId, chatId: info.chatId })) {
    await replyLong(ctx, "当前用户或群未加入白名单，无法处理附件。发送 /cxwhoami 获取 id 后写入 .env。");
    return;
  }
  if (busyChats.has(info.chatId)) {
    await replyLong(ctx, "⏳ 这个群里上一个任务还在处理中，请稍候再发。");
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
    fileId = msg.photo[msg.photo.length - 1].file_id;
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
      deps.config.telegramProxyUrl,
      deps.config.downloadsDir,
    );
  } catch (error) {
    await replyLong(ctx, `下载附件失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  } finally {
    if (note) {
      await ctx.telegram.deleteMessage(Number(info.chatId), note.message_id).catch(() => {});
    }
  }

  logger.info("Downloaded attachment", { chatId: info.chatId, fileName, mime, localPath });

  const message = [
    trigger.cleanedText || "请读取并处理这个附件。",
    "",
    `[附件已下载到本机：${localPath}（文件名：${fileName ?? "未知"}，类型：${mime ?? "未知"}）。`,
    "请读取/分析它；若是 .docx/.doc/.xlsx/.pptx 等非纯文本，可用 textutil -convert txt -stdout <文件> 等工具转换后读取。]",
  ].join("\n");

  await processCodexMessage(ctx, deps, info, message);
}

async function processCodexMessage(
  ctx: Context,
  deps: Deps,
  info: ChatInfo,
  message: string,
): Promise<void> {
  const { config, taskStore, codexRunner, modelStore, workspaceStore, sessionStore } = deps;

  if (!isAuthorized(config, { userId: info.userId, chatId: info.chatId })) {
    await replyLong(ctx, "当前用户或群未加入白名单。发送 /cxwhoami 获取 user_id 和 chat_id，再写入 .env。");
    return;
  }
  if (!message.trim()) {
    await replyLong(ctx, "你想让我做什么？直接说就行。");
    return;
  }
  if (busyChats.has(info.chatId)) {
    await replyLong(ctx, "⏳ 这个群里上一个任务还在处理中，请稍候再发。");
    return;
  }
  if (!config.runCodexEnabled) {
    await replyLong(ctx, "Codex 执行未开启（RUN_CODEX_ENABLED=false），只能记录不能执行。");
    return;
  }

  const workspaceDir = workspaceStore.get(info.chatId, config.codexWorkspaceDir);
  const model = modelStore.get(info.chatId, config.codexModel);

  const task = await taskStore.createTask({
    prefix: "DEV",
    intent: "development",
    codeChangePolicy: "allow-change",
    summary: truncateText(message.replace(/\s+/g, " ").trim(), 120),
    sourceText: message,
    userId: info.userId,
    username: info.username,
    chatId: info.chatId,
    chatType: info.chatType,
  });

  busyChats.add(info.chatId);
  const ack = await ctx.reply("🐾 收到，正在处理…").catch(() => null);
  await ctx.replyWithChatAction("typing").catch(() => {});
  const typingTimer = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 5000);

  try {
    const existingSession = sessionStore.get(info.chatId);
    let result = await codexRunner.run({
      message,
      workspaceDir,
      model,
      sessionId: existingSession,
      taskId: task.id,
    });

    // 续接失败（会话过期等）→ 清掉旧会话，用新会话重试一次
    if (!result.ok && existingSession) {
      logger.warn("Resume likely failed, retrying with a fresh session", { chatId: info.chatId });
      sessionStore.clear(info.chatId);
      result = await codexRunner.run({
        message,
        workspaceDir,
        model,
        sessionId: undefined,
        taskId: task.id,
      });
    }

    if (result.sessionId) {
      sessionStore.set(info.chatId, result.sessionId);
    }

    task.status = result.ok ? "completed" : "failed";
    task.logPrefix = result.logPrefix;
    task.executionNotes = truncateText(result.text, 2000);
    await taskStore.updateTask(task);

    if (ack) {
      await ctx.telegram.deleteMessage(Number(info.chatId), ack.message_id).catch(() => {});
    }
    await replyLong(ctx, result.text);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    task.status = "failed";
    task.executionNotes = `执行异常：${errorMessage}`;
    await taskStore.updateTask(task);
    logger.error("Codex run failed", { taskId: task.id, message: errorMessage });
    if (ack) {
      await ctx.telegram.deleteMessage(Number(info.chatId), ack.message_id).catch(() => {});
    }
    await replyLong(ctx, `处理失败：${errorMessage}`);
  } finally {
    clearInterval(typingTimer);
    busyChats.delete(info.chatId);
  }
}

async function replyLong(ctx: Context, text: string): Promise<void> {
  const replyToId = (ctx.message as { message_id?: number } | undefined)?.message_id;
  const chunks = splitMessageByLength(text, 3500);
  for (const chunk of chunks) {
    await ctx.reply(
      chunk,
      replyToId ? { reply_parameters: { message_id: replyToId } } : undefined,
    );
  }
}
