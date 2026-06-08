import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_USER_IDS: z.string().default(""),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().default(""),
  RUN_CODEX_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value.trim().toLowerCase() === "true"),
  CODEX_WORKSPACE_DIR: z
    .string()
    .min(1, "CODEX_WORKSPACE_DIR is required")
    .transform((value) => path.resolve(value)),
  BOT_TRIGGER_NAMES: z
    .string()
    .default("Codex,codex,Codex1,Codex2")
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  TELEGRAM_PROXY_URL: z.string().optional(),
  CODEX_BIN: z.string().default("codex"),
  CODEX_MODEL: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  // 默认解除 codex 沙箱与审批，让 cx 像本机/客户端一样自由读写本地（含 .git）。
  // 设为 false 可恢复沙箱（仅 workspace-write、.git 只读）。
  CODEX_DANGEROUS_BYPASS: z
    .string()
    .default("true")
    .transform((value) => value.trim().toLowerCase() !== "false"),
  CODEX_TIMEOUT_MS: z
    .string()
    .default("120000")
    .transform((value) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
    }),
});

function parseCsvSet(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export interface AppConfig {
  telegramBotToken: string;
  allowedUserIds: Set<string>;
  allowedChatIds: Set<string>;
  runCodexEnabled: boolean;
  codexWorkspaceDir: string;
  botTriggerNames: string[];
  telegramProxyUrl?: string;
  codexBin: string;
  codexModel?: string;
  codexBypassSandbox: boolean;
  codexTimeoutMs: number;
  projectRootDir: string;
  tasksDir: string;
  logsDir: string;
  stateDir: string;
  modelsFile: string;
  workspacesFile: string;
  sessionsFile: string;
  downloadsDir: string;
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);
  const projectRootDir = process.cwd();

  return {
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    allowedUserIds: parseCsvSet(parsed.TELEGRAM_ALLOWED_USER_IDS),
    allowedChatIds: parseCsvSet(parsed.TELEGRAM_ALLOWED_CHAT_IDS),
    runCodexEnabled: parsed.RUN_CODEX_ENABLED,
    codexWorkspaceDir: parsed.CODEX_WORKSPACE_DIR,
    botTriggerNames: parsed.BOT_TRIGGER_NAMES,
    telegramProxyUrl:
      parsed.TELEGRAM_PROXY_URL?.trim() ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy ||
      undefined,
    codexBin: parsed.CODEX_BIN,
    codexModel: parsed.CODEX_MODEL,
    codexBypassSandbox: parsed.CODEX_DANGEROUS_BYPASS,
    codexTimeoutMs: parsed.CODEX_TIMEOUT_MS,
    projectRootDir,
    tasksDir: path.join(projectRootDir, "tasks"),
    logsDir: path.join(projectRootDir, "logs"),
    stateDir: path.join(projectRootDir, "state"),
    modelsFile: path.join(projectRootDir, "state", "models.json"),
    workspacesFile: path.join(projectRootDir, "state", "workspaces.json"),
    sessionsFile: path.join(projectRootDir, "state", "sessions.json"),
    downloadsDir: path.join(projectRootDir, "downloads"),
  };
}
