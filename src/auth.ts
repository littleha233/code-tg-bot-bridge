import type { AppConfig } from "./config";

export interface AuthContext {
  userId?: string;
  chatId: string;
}

export function isIdentityQuery(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("我是谁") ||
    normalized.includes("查看我的 id") ||
    normalized.includes("查看我的id") ||
    normalized.includes("我的 id") ||
    normalized.includes("我的id") ||
    normalized.includes("当前群 id") ||
    normalized.includes("当前群id") ||
    normalized.includes("chat id") ||
    normalized.includes("user_id") ||
    normalized.includes("chat_id")
  );
}

export function isAuthorized(config: AppConfig, context: AuthContext): boolean {
  const userAllowed = context.userId ? config.allowedUserIds.has(context.userId) : false;
  const chatAllowed = config.allowedChatIds.has(context.chatId);

  return userAllowed && chatAllowed;
}
