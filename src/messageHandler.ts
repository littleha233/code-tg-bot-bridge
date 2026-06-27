import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { truncateText } from "./text";
import { mdToTelegramHtml, stripMarkdown, chunkByLine } from "./telegramFormat";
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

  // 进度面板：实时编辑同一条消息，展示 cx 正在做的步骤，方便监督
  const progress = new ProgressReporter(ctx, info.chatId);
  await progress.start();

  try {
    const existingSession = sessionStore.get(info.chatId);

    // 开新会话且有压缩摘要 → 把摘要作为背景注入第一条消息
    let effectiveMessage = message;
    if (!existingSession) {
      const seed = sessionStore.getPendingSeed(info.chatId);
      if (seed) {
        effectiveMessage = `【上一段对话的上下文摘要，请作为背景记住】\n${seed}\n\n【用户新消息】\n${message}`;
        sessionStore.clearPendingSeed(info.chatId);
      }
    }

    const runOnce = (sessionId: string | undefined) =>
      codexRunner.run({
        message: effectiveMessage,
        workspaceDir,
        model,
        sessionId,
        taskId: task.id,
        onProgress: (step) => progress.push(step),
      });

    let result = await runOnce(existingSession);

    // 续接失败（会话过期等）→ 清掉旧会话，用新会话重试一次
    if (!result.ok && existingSession) {
      logger.warn("Resume likely failed, retrying with a fresh session", { chatId: info.chatId });
      sessionStore.clear(info.chatId);
      result = await runOnce(undefined);
    }

    if (result.sessionId) {
      sessionStore.set(info.chatId, result.sessionId);
    }

    task.status = result.ok ? "completed" : "failed";
    task.logPrefix = result.logPrefix;
    task.executionNotes = truncateText(result.text, 2000);
    await taskStore.updateTask(task);

    await progress.finish(result.ok);
    const { text: cleaned, files } = extractAttachments(result.text);
    // 回复投递单独兜底：codex 已算完，若只是代理抖动导致发不出去，
    // 不能让进度面板假装"处理中"，要如实告知发送失败（结果在日志里）。
    try {
      if (cleaned) {
        await replyLong(ctx, cleaned);
      } else if (files.length === 0) {
        await replyLong(ctx, result.text || "(空)");
      }
      await sendAttachments(ctx, files);
    } catch (deliveryError) {
      const msg = deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
      logger.error("Reply delivery failed after retries", { taskId: task.id, message: msg });
      await progress.deliveryFailed();
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    task.status = "failed";
    task.executionNotes = `执行异常：${errorMessage}`;
    await taskStore.updateTask(task);
    logger.error("Codex run failed", { taskId: task.id, message: errorMessage });
    await progress.fail();
    await replyLong(ctx, `处理失败：${errorMessage}`);
  } finally {
    progress.stop();
    busyChats.delete(info.chatId);
  }
}

/** 进度面板：把 codex 的执行步骤实时编辑进同一条 Telegram 消息（节流 2.5s） */
class ProgressReporter {
  private steps: string[] = [];
  private messageId?: number;
  private lastRendered = "";
  private dirty = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly ctx: Context,
    private readonly chatId: string,
  ) {}

  async start(): Promise<void> {
    const initial = "🛠 cx 处理中…";
    const msg = await this.ctx.reply(initial).catch(() => null);
    this.messageId = msg?.message_id;
    this.lastRendered = initial;
    this.timer = setInterval(() => {
      void this.flush();
    }, 2500);
    await this.ctx.replyWithChatAction("typing").catch(() => {});
  }

  push(step: string): void {
    this.steps.push(step);
    this.dirty = true;
  }

  private render(): string {
    const shown = this.steps.slice(-20);
    const omitted = this.steps.length - shown.length;
    const lines = ["🛠 cx 处理中…"];
    if (omitted > 0) {
      lines.push(`…（前 ${omitted} 步略）`);
    }
    shown.forEach((step, index) => lines.push(`${omitted + index + 1}. ${step}`));
    return lines.join("\n").slice(0, 3500);
  }

  private async flush(): Promise<void> {
    if (!this.dirty || !this.messageId) {
      return;
    }
    const text = this.render();
    this.dirty = false;
    if (text === this.lastRendered) {
      return;
    }
    this.lastRendered = text;
    await this.ctx.telegram
      .editMessageText(Number(this.chatId), this.messageId, undefined, text)
      .catch(() => {});
  }

  async finish(ok: boolean): Promise<void> {
    this.stop();
    if (!this.messageId) {
      return;
    }
    // 纯问答没有步骤 → 删掉进度消息保持干净
    if (this.steps.length === 0) {
      await this.ctx.telegram.deleteMessage(Number(this.chatId), this.messageId).catch(() => {});
      return;
    }
    const tailCount = Math.min(8, this.steps.length);
    const startIndex = this.steps.length - tailCount;
    const tail = this.steps
      .slice(startIndex)
      .map((step, index) => `${startIndex + index + 1}. ${step}`);
    const head = ok
      ? `✅ cx 完成（共 ${this.steps.length} 步）`
      : `⚠️ cx 结束（共 ${this.steps.length} 步，未完全成功）`;
    const text = [head, ...tail].join("\n").slice(0, 3500);
    await this.ctx.telegram
      .editMessageText(Number(this.chatId), this.messageId, undefined, text)
      .catch(() => {});
  }

  async fail(): Promise<void> {
    this.stop();
    if (!this.messageId) {
      return;
    }
    await this.ctx.telegram
      .editMessageText(
        Number(this.chatId),
        this.messageId,
        undefined,
        `❌ cx 处理失败（共 ${this.steps.length} 步）`,
      )
      .catch(() => {});
  }

  /** codex 已完成、但回复发不出去（多为代理抖动）：如实告知，别假装"处理中" */
  async deliveryFailed(): Promise<void> {
    this.stop();
    if (!this.messageId) {
      return;
    }
    await this.ctx.telegram
      .editMessageText(
        Number(this.chatId),
        this.messageId,
        undefined,
        `⚠️ cx 已完成，但回复发送失败（网络/代理抖动）。结果已写入日志，可重发上一条消息再试。`,
      )
      .catch(() => {});
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

// 从 codex 回复里提取要发送的本机文件：[[file: 路径]] 或 Markdown 图片 ![](路径)
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

function expandHomePath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function extractAttachments(text: string): { text: string; files: string[] } {
  const files: string[] = [];
  let cleaned = text;
  const patterns = [/!\[[^\]]*\]\(\s*([^)]+?)\s*\)/g, /\[\[file:\s*([^\]]+?)\s*\]\]/g];
  for (const re of patterns) {
    cleaned = cleaned.replace(re, (match, captured: string) => {
      const filePath = expandHomePath(captured.trim());
      if (filePath.startsWith("/") && existsSync(filePath) && statSync(filePath).isFile()) {
        files.push(filePath);
        return "";
      }
      return match; // 不是本地文件（如 http 链接）就原样保留
    });
  }
  return { text: cleaned.replace(/\n{3,}/g, "\n\n").trim(), files };
}

async function sendAttachments(ctx: Context, files: string[]): Promise<void> {
  for (const file of files) {
    const ext = (file.match(/\.[^./]+$/)?.[0] ?? "").toLowerCase();
    try {
      await tgRetry<unknown>(() =>
        IMAGE_EXT.has(ext)
          ? ctx.replyWithPhoto({ source: file })
          : ctx.replyWithDocument({ source: file }),
      );
    } catch (error) {
      await ctx
        .reply(
          `⚠️ 上传文件失败 ${path.basename(file)}：${error instanceof Error ? error.message : String(error)}`,
        )
        .catch(() => {});
    }
  }
}

async function replyLong(ctx: Context, text: string): Promise<void> {
  const replyToId = (ctx.message as { message_id?: number } | undefined)?.message_id;
  const replyExtra = replyToId ? { reply_parameters: { message_id: replyToId } } : {};
  // 常见短回复整条发；超长才按源码行切，保证每段 HTML 标签自洽
  const chunks = mdToTelegramHtml(text).length <= 3900 ? [text] : chunkByLine(text, 3200);
  for (const chunk of chunks) {
    const html = mdToTelegramHtml(chunk);
    if (!html) continue;
    try {
      // HTML 发送带网络重试：代理 TLS 抖动时不至于让回复石沉大海
      await tgRetry(() =>
        ctx.reply(html, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...replyExtra,
        }),
      );
    } catch (error) {
      const m = error instanceof Error ? error.message : String(error);
      // 解析类失败（HTML 转换边角）→ 退回纯文本，别误判成投递失败
      if (/parse entities|can't parse|Bad Request/i.test(m)) {
        logger.warn("HTML 渲染被 Telegram 拒绝，退回纯文本", { message: m });
        await tgRetry(() => ctx.reply(stripMarkdown(chunk), replyExtra));
      } else {
        throw error; // 网络类失败 → 交给上层 deliveryFailed 兜底
      }
    }
  }
}

/**
 * 给 Telegram 调用加重试 + 退避。主要应对代理（FlyingBird 7892）偶发
 * "Client network socket disconnected before secure TLS connection" 之类的瞬断。
 * 重试用尽仍失败才抛出，交由上层决定如何兜底。
 */
async function tgRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 800 * (i + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
