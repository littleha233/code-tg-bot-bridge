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
const NO_CHANGE_PATTERNS = ["先不要改代码", "先别改代码", "别改代码", "只分析", "只给方案", "不要改代码", "不要开发", "不要修改", "先别动代码"];
const ANALYSIS_PATTERNS = [
  "分析", "方案", "拆解", "review", "检查代码", "测试", "看看有没有报错", "评估",
  // 常见的“读/熟悉/了解”类说法，都按只读任务处理
  "阅读", "读一下", "读下", "读读", "读代码", "读源码", "看一下", "看下", "看看",
  "熟悉", "了解", "梳理", "理解", "搞懂", "解释", "说明", "总结", "概览", "介绍",
  "调研", "摸清", "审查", "评审", "看代码", "看源码",
];
const ALLOW_CHANGE_PATTERNS = ["开始开发", "直接改", "实现一下", "帮我实现", "修复", "修改", "开发", "实现登录页", "重构", "新增", "加一个", "写一个", "改一下", "优化一下"];
// 纯问候/闲聊/简单确认，才回套话；其余实质消息一律交给 codex
const CASUAL_PATTERNS = [
  "你好", "您好", "哈喽", "嗨", "在吗", "在不在", "在么", "在不", "早上好", "中午好",
  "下午好", "晚上好", "晚安", "谢谢", "多谢", "辛苦了", "辛苦", "收到", "好的", "明白了",
  "知道了", "hello", "hi", "hey", "ok", "okay",
];

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

  // 明确要求“别改代码” → 只读分析（优先级最高，保证安全）
  if (hasAny(lowerText, NO_CHANGE_PATTERNS)) {
    return buildIntent("analysis", "no-change", normalizedText, true);
  }

  // 明确要求改/实现/修复/重构 → 开发
  if (hasAny(lowerText, ALLOW_CHANGE_PATTERNS)) {
    return buildIntent("development", "allow-change", normalizedText, true);
  }

  // 读/熟悉/分析类 → 只读分析
  if (hasAny(lowerText, ANALYSIS_PATTERNS)) {
    return buildIntent("analysis", "no-change", normalizedText, true);
  }

  // 纯问候/确认 → 套话
  if (hasAny(lowerText, CASUAL_PATTERNS)) {
    return buildIntent("casual", "record-only", normalizedText, false);
  }

  // 兜底：其余实质性消息默认按“只读分析任务”交给 codex，而不是当闲聊忽略。
  // 只读分析不会改代码，安全；这样不会再漏掉用户的真实诉求。
  return buildIntent("analysis", "no-change", normalizedText, true);
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
