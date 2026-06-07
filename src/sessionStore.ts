import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createLogger } from "./logger";

const logger = createLogger("sessionStore");

/**
 * 每个 chat 一个 codex 会话 id（thread_id），用于 `codex exec resume` 续接，
 * 实现像 cc 那样的连续对话。对标 cc 的 data/sessions.json。
 */
export class SessionStore {
  private sessions: Record<string, string> = {};

  constructor(private readonly filePath: string) {
    try {
      this.sessions = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      this.sessions = {};
    }
  }

  get(chatId: string): string | undefined {
    return this.sessions[chatId];
  }

  set(chatId: string, sessionId: string): void {
    this.sessions[chatId] = sessionId;
    this.persist();
  }

  clear(chatId: string): void {
    delete this.sessions[chatId];
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.sessions, null, 2));
    } catch (error) {
      logger.error("Failed to persist sessions", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
