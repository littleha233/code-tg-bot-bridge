import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "./logger";

const logger = createLogger("workspaceStore");

export interface SetWorkspaceResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * 每个 chat 独立的工作目录，持久化到 JSON 文件。对标 cc 的 /ccproject。
 * 未设置时回退到 config.codexWorkspaceDir（.env 的 CODEX_WORKSPACE_DIR）。
 */
export class WorkspaceStore {
  private workspaces: Record<string, string> = {};

  constructor(private readonly filePath: string) {
    try {
      this.workspaces = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      this.workspaces = {};
    }
  }

  get(chatId: string, fallback: string): string {
    return this.workspaces[chatId] || fallback;
  }

  set(chatId: string, rawPath: string): SetWorkspaceResult {
    const resolved = path.resolve(expandHome(rawPath.trim()));
    try {
      if (!statSync(resolved).isDirectory()) {
        return { ok: false, error: "这不是一个目录" };
      }
    } catch {
      return { ok: false, error: "目录不存在" };
    }

    this.workspaces[chatId] = resolved;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.workspaces, null, 2));
    } catch (error) {
      logger.error("Failed to persist workspace", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { ok: true, path: resolved };
  }
}

function expandHome(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
