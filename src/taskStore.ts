import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type TaskStatus = "created" | "recorded" | "running" | "completed" | "failed";
export type TaskIntent = "record" | "analysis" | "development" | "continue";
export type CodeChangePolicy = "record-only" | "no-change" | "allow-change";

export interface TaskRecord {
  id: string;
  fileName: string;
  absolutePath: string;
  createdAt: string;
  status: TaskStatus;
  intent: TaskIntent;
  codeChangePolicy: CodeChangePolicy;
  summary: string;
  sourceText: string;
  userId: string;
  username: string;
  chatId: string;
  chatType: string;
  relatedTaskId?: string;
  executionNotes?: string;
  logPrefix?: string;
}

export interface CreateTaskInput {
  prefix: "TASK" | "ANALYZE" | "DEV";
  intent: TaskIntent;
  codeChangePolicy: CodeChangePolicy;
  summary: string;
  sourceText: string;
  userId: string;
  username: string;
  chatId: string;
  chatType: string;
  relatedTaskId?: string;
}

export class TaskStore {
  constructor(
    private readonly tasksDir: string,
    private readonly logsDir: string,
  ) {}

  async ensureReady(): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });
    await mkdir(this.logsDir, { recursive: true });
    await writeIfMissing(path.join(this.tasksDir, ".gitkeep"), "");
    await writeIfMissing(path.join(this.logsDir, ".gitkeep"), "");
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const id = `${input.prefix}-${formatTimestampForId(new Date())}`;
    const fileName = `${id}.md`;
    const absolutePath = path.join(this.tasksDir, fileName);

    const record: TaskRecord = {
      id,
      fileName,
      absolutePath,
      createdAt: new Date().toISOString(),
      status: "created",
      intent: input.intent,
      codeChangePolicy: input.codeChangePolicy,
      summary: input.summary,
      sourceText: input.sourceText,
      userId: input.userId,
      username: input.username,
      chatId: input.chatId,
      chatType: input.chatType,
      relatedTaskId: input.relatedTaskId,
    };

    await this.writeTask(record);
    return record;
  }

  async updateTask(record: TaskRecord): Promise<void> {
    await this.writeTask(record);
  }

  async getLatestTask(chatId?: string): Promise<TaskRecord | null> {
    const files = await this.getTaskFiles(chatId);
    if (files.length === 0) {
      return null;
    }

    return this.readTask(path.join(this.tasksDir, files[0]));
  }

  async countTasks(chatId?: string): Promise<number> {
    const files = await this.getTaskFiles(chatId);
    return files.length;
  }

  async getLatestTaskContent(chatId?: string): Promise<string | null> {
    const latestTask = await this.getLatestTask(chatId);
    if (!latestTask) {
      return null;
    }

    return readFile(latestTask.absolutePath, "utf8");
  }

  private async getTaskFiles(chatId?: string): Promise<string[]> {
    const entries = await readdir(this.tasksDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left));

    if (!chatId) {
      return files;
    }

    const matchedFiles: string[] = [];
    for (const fileName of files) {
      const task = await this.readTask(path.join(this.tasksDir, fileName));
      if (task.chatId === chatId) {
        matchedFiles.push(fileName);
      }
    }

    return matchedFiles;
  }

  private async writeTask(record: TaskRecord): Promise<void> {
    const frontmatter = serializeFrontmatter({
      id: record.id,
      createdAt: record.createdAt,
      status: record.status,
      intent: record.intent,
      codeChangePolicy: record.codeChangePolicy,
      userId: record.userId,
      username: record.username,
      chatId: record.chatId,
      chatType: record.chatType,
      relatedTaskId: record.relatedTaskId ?? "",
      logPrefix: record.logPrefix ?? "",
    });

    const sections = [
      frontmatter,
      "# Summary",
      record.summary,
      "",
      "# Source Message",
      record.sourceText,
      "",
      "# Execution Notes",
      record.executionNotes ?? "N/A",
      "",
    ];

    await writeFile(record.absolutePath, sections.join("\n"), "utf8");
  }

  private async readTask(absolutePath: string): Promise<TaskRecord> {
    const content = await readFile(absolutePath, "utf8");
    const { frontmatter, body } = parseMarkdownTask(content);
    const summary = extractSection(body, "Summary");
    const sourceText = extractSection(body, "Source Message");
    const executionNotes = extractSection(body, "Execution Notes");
    const fileName = path.basename(absolutePath);

    return {
      id: frontmatter.id,
      fileName,
      absolutePath,
      createdAt: frontmatter.createdAt,
      status: frontmatter.status as TaskStatus,
      intent: frontmatter.intent as TaskIntent,
      codeChangePolicy: frontmatter.codeChangePolicy as CodeChangePolicy,
      summary,
      sourceText,
      userId: frontmatter.userId,
      username: frontmatter.username,
      chatId: frontmatter.chatId,
      chatType: frontmatter.chatType,
      relatedTaskId: frontmatter.relatedTaskId || undefined,
      logPrefix: frontmatter.logPrefix || undefined,
      executionNotes: executionNotes === "N/A" ? undefined : executionNotes,
    };
  }
}

function formatTimestampForId(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function serializeFrontmatter(data: Record<string, string>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    lines.push(`${key}: ${value.replace(/\n/g, " ").trim()}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function parseMarkdownTask(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error("Invalid task file format.");
  }

  const frontmatterLines = match[1].split("\n");
  const frontmatter: Record<string, string> = {};
  for (const line of frontmatterLines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    frontmatter[key] = value;
  }

  return { frontmatter, body: match[2] };
}

function extractSection(body: string, title: string): string {
  const pattern = new RegExp(`# ${escapeRegExp(title)}\\n([\\s\\S]*?)(?:\\n# |$)`);
  const match = body.match(pattern);
  return match?.[1]?.trim() ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeIfMissing(absolutePath: string, content: string): Promise<void> {
  try {
    await readFile(absolutePath, "utf8");
  } catch {
    await writeFile(absolutePath, content, "utf8");
  }
}
