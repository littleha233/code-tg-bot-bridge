export type IntentKind =
  | "identity"
  | "status"
  | "record"
  | "analysis"
  | "development"
  | "continue"
  | "casual";

export type CodeChangePolicy = "record-only" | "no-change" | "allow-change";

export interface ParsedIntent {
  kind: IntentKind;
  codeChangePolicy: CodeChangePolicy;
  summary: string;
  cleanedText: string;
  shouldCreateTask: boolean;
}

export interface TriggerMatchResult {
  shouldProcess: boolean;
  cleanedText: string;
}

const IDENTITY_PATTERNS = [
  "我是谁",
  "查看我的 id",
  "查看我的id",
  "我的 id",
  "我的id",
  "当前群 id",
  "当前群id",
  "chat id",
  "chat_id",
  "user_id",
];

const STATUS_PATTERNS = ["现在状态怎么样", "现在能不能工作", "查看 agent 状态", "查看agent状态", "agent 状态", "codex 现在能不能工作", "状态怎么样"];

const CONTINUE_PATTERNS = [
  "继续刚才那个任务",
  "刚才那个继续",
  "把上一个任务修一下",
  "继续上一个任务",
  "继续刚才的任务",
  "继续任务",
];

const RECORD_PATTERNS = ["记录一个任务", "整理成开发任务", "整理成任务", "先把这个需求整理成任务", "不要开发", "先记录"];
const NO_CHANGE_PATTERNS = ["先不要改代码", "先别改代码", "别改代码", "只分析", "只给方案", "不要改代码", "不要开发"];
const ANALYSIS_PATTERNS = ["分析", "方案", "拆解", "review", "检查代码", "测试", "看看有没有报错", "评估"];
const ALLOW_CHANGE_PATTERNS = ["开始开发", "直接改", "实现一下", "帮我实现", "修复", "修改", "开发", "实现登录页"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateText(value: string, maxLength = 120): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

export function detectTrigger(
  text: string,
  chatType: string,
  botUsername: string | undefined,
  triggerNames: string[],
  isReplyToBot = false,
): TriggerMatchResult {
  const sourceText = text.trim();
  if (!sourceText) {
    return { shouldProcess: false, cleanedText: "" };
  }

  if (chatType === "private") {
    return {
      shouldProcess: true,
      cleanedText: stripTriggers(sourceText, botUsername, triggerNames),
    };
  }

  if (isReplyToBot) {
    return {
      shouldProcess: true,
      cleanedText: stripTriggers(sourceText, botUsername, triggerNames),
    };
  }

  const lowerText = sourceText.toLowerCase();
  const hasConfiguredTrigger = triggerNames.some((name) => lowerText.includes(name.toLowerCase()));
  const hasBotMention = botUsername ? lowerText.includes(`@${botUsername.toLowerCase()}`) : false;

  if (!hasConfiguredTrigger && !hasBotMention) {
    return { shouldProcess: false, cleanedText: "" };
  }

  return {
    shouldProcess: true,
    cleanedText: stripTriggers(sourceText, botUsername, triggerNames),
  };
}

export function parseIntent(text: string): ParsedIntent {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  const lowerText = normalizedText.toLowerCase();

  if (IDENTITY_PATTERNS.some((pattern) => lowerText.includes(pattern.toLowerCase()))) {
    return buildIntent("identity", "record-only", normalizedText, false);
  }

  if (STATUS_PATTERNS.some((pattern) => lowerText.includes(pattern.toLowerCase()))) {
    return buildIntent("status", "record-only", normalizedText, false);
  }

  if (CONTINUE_PATTERNS.some((pattern) => lowerText.includes(pattern.toLowerCase()))) {
    const policy = hasAny(lowerText, NO_CHANGE_PATTERNS) ? "no-change" : "allow-change";
    return buildIntent("continue", policy, normalizedText, true);
  }

  if (RECORD_PATTERNS.some((pattern) => lowerText.includes(pattern.toLowerCase()))) {
    return buildIntent("record", "record-only", normalizedText, true);
  }

  if (hasAny(lowerText, NO_CHANGE_PATTERNS) || hasAny(lowerText, ANALYSIS_PATTERNS)) {
    return buildIntent("analysis", "no-change", normalizedText, true);
  }

  if (hasAny(lowerText, ALLOW_CHANGE_PATTERNS)) {
    return buildIntent("development", "allow-change", normalizedText, true);
  }

  return buildIntent("casual", "record-only", normalizedText, false);
}

function stripTriggers(text: string, botUsername: string | undefined, triggerNames: string[]): string {
  let cleaned = text;
  const triggerTokens = [...triggerNames];

  if (botUsername) {
    triggerTokens.push(`@${botUsername}`);
  }

  for (const token of triggerTokens) {
    const pattern = new RegExp(`(^|\\s|[,:：，。.!！？、\\-])${escapeRegExp(token)}(?=\\s|[,:：，。.!！？、\\-]|$)`, "gi");
    cleaned = cleaned.replace(pattern, " ");
  }

  cleaned = cleaned.replace(/^[,，:：。\-\s]+/, "").trim();
  return cleaned || text.trim();
}

function buildIntent(
  kind: IntentKind,
  codeChangePolicy: CodeChangePolicy,
  cleanedText: string,
  shouldCreateTask: boolean,
): ParsedIntent {
  return {
    kind,
    codeChangePolicy,
    summary: truncateText(cleanedText.replace(/\s+/g, " ").trim() || "未提供任务内容"),
    cleanedText,
    shouldCreateTask,
  };
}

function hasAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern.toLowerCase()));
}
