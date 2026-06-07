import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createLogger } from "./logger";

const logger = createLogger("modelStore");

/**
 * 每个 chat 独立的模型选择，持久化到 JSON 文件。
 * 对标 cc 的 data/models.json：opus/sonnet/haiku 这类别名直接交给 codex，
 * codex 用别名/完整 id 都可（codex exec -m <model>）。
 */
export class ModelStore {
  private models: Record<string, string> = {};

  constructor(private readonly filePath: string) {
    try {
      this.models = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      this.models = {};
    }
  }

  get(chatId: string, fallback?: string): string | undefined {
    return this.models[chatId] || fallback;
  }

  set(chatId: string, model: string): void {
    this.models[chatId] = model.trim();
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.models, null, 2));
    } catch (error) {
      logger.error("Failed to persist model selection", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
