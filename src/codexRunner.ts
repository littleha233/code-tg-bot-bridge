import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { AppConfig } from "./config";
import { createLogger } from "./logger";
import type { ParsedIntent } from "./intentParser";
import type { TaskRecord } from "./taskStore";

const logger = createLogger("codexRunner");
const NODE_BIN_DIR = path.dirname(process.execPath);

export interface CodexRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  summary: string;
  logPrefix: string;
}

export class CodexRunner {
  constructor(private readonly config: AppConfig) {}

  async runTask(
    task: TaskRecord,
    intent: ParsedIntent,
    recentTaskContent?: string | null,
    model?: string,
    workspaceDirArg?: string,
  ): Promise<CodexRunResult> {
    const workspaceDir = workspaceDirArg || this.config.codexWorkspaceDir;
    const workspaceExists = await pathExists(workspaceDir);
    if (!workspaceExists) {
      throw new Error(`工作目录不存在：${workspaceDir}`);
    }

    const prompt = buildCodexPrompt(intent, task, workspaceDir, recentTaskContent);
    const logPrefix = `${task.id}-${Date.now()}`;
    const promptLogPath = path.join(this.config.logsDir, `${logPrefix}.prompt.md`);
    const stdoutLogPath = path.join(this.config.logsDir, `${logPrefix}.stdout.log`);
    const stderrLogPath = path.join(this.config.logsDir, `${logPrefix}.stderr.log`);

    await writeFile(promptLogPath, prompt, "utf8");

    logger.info("Running codex exec", {
      taskId: task.id,
      workspace: workspaceDir,
      mode: intent.kind,
      codeChangePolicy: intent.codeChangePolicy,
      model: model ?? "(codex 默认)",
    });

    // 指定了模型就传 -m，否则用 codex 自身的默认模型
    const execArgs = ["exec", "--skip-git-repo-check", ...(model ? ["--model", model] : []), "-"];
    const result = await execa(this.config.codexBin, execArgs, {
      cwd: workspaceDir,
      timeout: this.config.codexTimeoutMs,
      reject: false,
      input: prompt,
      env: buildChildEnv(),
    });

    await writeFile(stdoutLogPath, result.stdout ?? "", "utf8");
    await writeFile(stderrLogPath, result.stderr ?? "", "utf8");

    const exitCode = result.exitCode ?? null;
    const summary = summarizeCodexOutput(result.stdout ?? "", result.stderr ?? "", exitCode);

    return {
      ok: exitCode === 0,
      exitCode,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      summary,
      logPrefix,
    };
  }
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

function buildCodexPrompt(
  intent: ParsedIntent,
  task: TaskRecord,
  workspaceDir: string,
  recentTaskContent?: string | null,
): string {
  const sharedRules = [
    "你正在作为 Telegram 群里的自然语言项目助手工作。",
    `当前工作目录固定为：${workspaceDir}`,
    "先阅读 README、AGENTS.md、package.json，再开始行动。",
    "先明确一个简短修改/分析计划，再执行。",
    "不要扩大需求范围，只处理当前消息要求的内容。",
    "所有输出请用中文，最后给出：修改摘要、测试结果、风险。",
  ];

  const modeRules =
    intent.codeChangePolicy === "allow-change"
      ? [
          "允许修改代码，但只做完成任务所必需的最小改动。",
          "完成后运行项目内可用的 typecheck、lint、test、build（按可用性执行，不要臆造命令）。",
        ]
      : [
          "本次任务禁止改代码，不允许写入项目文件。",
          "可以做只读分析；如果用户要求测试或检查代码，可以执行只读的检查或测试命令。",
          "不要运行会改变仓库内容的命令。",
        ];

  const recentTaskSection = recentTaskContent
    ? ["", "最近一个任务的完整记录如下，请把它作为上下文继续处理：", recentTaskContent].join("\n")
    : "";

  return [
    ...sharedRules,
    ...modeRules,
    "",
    `任务 ID：${task.id}`,
    `任务类型：${intent.kind}`,
    `代码变更策略：${intent.codeChangePolicy}`,
    `任务摘要：${task.summary}`,
    "",
    "用户原始消息：",
    task.sourceText,
    recentTaskSection,
  ]
    .filter(Boolean)
    .join("\n");
}

function summarizeCodexOutput(stdout: string, stderr: string, exitCode: number | null): string {
  const parts: string[] = [];
  parts.push(exitCode === 0 ? "Codex 执行完成。" : `Codex 执行失败，退出码：${exitCode ?? "unknown"}。`);

  if (stdout.trim()) {
    parts.push(truncateText(stdout.trim(), 2400));
  }

  if (exitCode !== 0 && stderr.trim()) {
    parts.push(`stderr:\n${truncateText(stderr.trim(), 1000)}`);
  }

  return parts.join("\n\n");
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
