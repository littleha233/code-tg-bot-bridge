import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { AppConfig } from "./config";
import { createLogger } from "./logger";

const logger = createLogger("codexRunner");
const NODE_BIN_DIR = path.dirname(process.execPath);

export interface CodexRunOptions {
  /** 用户这条消息（已去掉触发词） */
  message: string;
  /** 工作目录 */
  workspaceDir: string;
  /** 模型（可选，新会话时生效） */
  model?: string;
  /** 已有会话 id，则续接；否则开新会话 */
  sessionId?: string;
  /** 任务 id，用于日志文件名 */
  taskId: string;
  /** 实时进度回调：每执行一步（命令/改动）回调一次，用于推送到群里 */
  onProgress?: (step: string) => void;
}

export interface CodexRunResult {
  ok: boolean;
  /** codex 的自然语言回复 */
  text: string;
  /** 本次会话 id（用于下次续接） */
  sessionId?: string;
  logPrefix: string;
}

export class CodexRunner {
  constructor(private readonly config: AppConfig) {}

  async run(options: CodexRunOptions): Promise<CodexRunResult> {
    const { message, workspaceDir, model, sessionId, taskId } = options;

    if (!(await pathExists(workspaceDir))) {
      throw new Error(`工作目录不存在：${workspaceDir}`);
    }

    // 续接会话时只发用户消息（上下文已在会话里）；新会话时附上简短的角色说明
    const input = sessionId ? message : buildFreshPrompt(message, workspaceDir);

    const logPrefix = `${taskId}-${Date.now()}`;
    await writeFile(path.join(this.config.logsDir, `${logPrefix}.prompt.md`), input, "utf8");

    // 默认解除沙箱与审批，让 cx 像本机/客户端一样自由读写本地（含 .git、切分支、提交）。
    const accessFlags = this.config.codexBypassSandbox
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : [];

    const args = sessionId
      ? ["exec", "resume", sessionId, "--skip-git-repo-check", ...accessFlags, "--json", "-"]
      : ["exec", "--skip-git-repo-check", ...accessFlags, ...(model ? ["--model", model] : []), "--json", "-"];

    logger.info("Running codex exec", {
      taskId,
      workspace: workspaceDir,
      resume: Boolean(sessionId),
      model: model ?? "(codex 默认)",
      bypassSandbox: this.config.codexBypassSandbox,
    });

    // 流式读取 codex 的 JSONL，边跑边回调进度，同时收集最终回复
    const subprocess = execa(this.config.codexBin, args, {
      cwd: workspaceDir,
      timeout: this.config.codexTimeoutMs,
      reject: false,
      input,
      env: buildChildEnv(),
    });

    const messages: string[] = [];
    let resolvedSessionId: string | undefined;
    let errored = false;
    let buffer = "";

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        return;
      }
      let evt: {
        type?: string;
        thread_id?: string;
        item?: {
          type?: string;
          text?: string;
          command?: string;
          status?: string;
          changes?: Array<{ path?: string }>;
        };
      };
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return; // 跳过非 JSON 行
      }

      if (evt.type === "thread.started" && evt.thread_id) {
        resolvedSessionId = evt.thread_id;
      } else if (evt.type === "item.started" && evt.item?.type === "command_execution") {
        options.onProgress?.(`🔧 ${shorten(stripShell(evt.item.command ?? ""), 120)}`);
      } else if (evt.type === "item.completed") {
        const item = evt.item;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          messages.push(item.text);
        } else if (item?.type === "file_change" && Array.isArray(item.changes)) {
          const files = item.changes
            .map((change) => path.basename(String(change.path ?? "")))
            .filter(Boolean)
            .join(", ");
          if (files) {
            options.onProgress?.(`📝 改动: ${shorten(files, 120)}`);
          }
        } else if (item?.type === "command_execution" && item.status === "failed") {
          options.onProgress?.(`⚠️ 命令失败: ${shorten(stripShell(item.command ?? ""), 100)}`);
        }
      } else if (evt.type === "turn.failed" || evt.type === "error") {
        errored = true;
      }
    };

    subprocess.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
      }
    });

    const result = await subprocess;
    if (buffer.trim()) {
      handleLine(buffer);
    }

    await writeFile(path.join(this.config.logsDir, `${logPrefix}.stdout.log`), result.stdout ?? "", "utf8");
    await writeFile(path.join(this.config.logsDir, `${logPrefix}.stderr.log`), result.stderr ?? "", "utf8");

    const exitOk = result.exitCode === 0;
    const finalText = messages.join("\n\n").trim();
    const text =
      finalText ||
      (exitOk
        ? "（codex 这次没有产生文本回复）"
        : `codex 执行失败（退出码 ${result.exitCode ?? "unknown"}）。\n${truncateText((result.stderr ?? "").trim(), 800)}`);

    return {
      ok: exitOk && !errored && finalText.length > 0,
      text,
      sessionId: resolvedSessionId ?? sessionId,
      logPrefix,
    };
  }
}

/** 去掉 codex 命令外层的 `/bin/zsh -lc '...'` 包裹，显示真实命令 */
function stripShell(command: string): string {
  const quoted = command.match(/-l?c\s+'([\s\S]*)'\s*$/) ?? command.match(/-l?c\s+"([\s\S]*)"\s*$/);
  if (quoted) {
    return quoted[1].trim();
  }
  const unquoted = command.match(/\s-l?c\s+([\s\S]*)$/);
  return (unquoted ? unquoted[1] : command).trim();
}

function shorten(value: string, maxLength: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 1)}…`;
}

function buildFreshPrompt(message: string, workspaceDir: string): string {
  return [
    "你是 Telegram 群里的开发助手 Codex，用中文自然地和用户对话，像同事一样直接、简洁。",
    `当前工作目录：${workspaceDir}`,
    "可以按需读取文件、运行命令、读写本地文件来理解和推进任务（首次接触某项目时先看 README / AGENTS.md）。",
    "",
    "【主动推进】如果是多步骤/较重的任务，请一次性把它做完：自己规划步骤并连续执行（读文件 → 改代码 → 跑测试/构建 → 修正），不要做一步就停下来等我确认。只有遇到真正需要我拍板的岔路（不可逆操作、需求二义、缺少关键信息）才停下来问我，并说清楚卡在哪、需要我决定什么。",
    "【改代码原则】默认只做分析与回答；只有用户明确要求“实现/修改/修复/新增/重构”时才改代码，保持最小改动，完成后说明改了什么、跑了哪些验证、有什么风险。",
    "【汇报】最后用要点汇报：做了什么、结果如何、还有什么待办或风险。回复直接给结论，不要贴大段命令回显。",
    "",
    "用户消息：",
    message,
  ].join("\n");
}

function buildChildEnv(): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "1",
    PATH: `${NODE_BIN_DIR}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`,
  };

  const proxyUrl =
    process.env.TELEGRAM_PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;

  if (proxyUrl) {
    nextEnv.HTTPS_PROXY = proxyUrl;
    nextEnv.HTTP_PROXY = proxyUrl;
    nextEnv.https_proxy = proxyUrl;
    nextEnv.http_proxy = proxyUrl;
  }

  return nextEnv;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 11)}\n\n[内容已截断]`;
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
