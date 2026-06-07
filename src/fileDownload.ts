import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { Context } from "telegraf";

/**
 * 把 Telegram 上的文件下载到本机，返回绝对路径。经同一个代理下载（国内必需）。
 * 对标 cc 的 downloadTelegramFile。
 */
export async function downloadTelegramFile(
  ctx: Context,
  fileId: string,
  suggestedName: string | undefined,
  proxyUrl: string | undefined,
  downloadDir: string,
): Promise<string> {
  const link = await ctx.telegram.getFileLink(fileId);
  const url = typeof link === "string" ? link : link.href;

  await mkdir(downloadDir, { recursive: true });
  const fallbackName = url.split("/").pop() || "file";
  const safeName = (suggestedName || fallbackName).replace(/[/\\]/g, "_");
  const dest = path.join(downloadDir, `${Date.now()}_${safeName}`);

  const agent = proxyUrl
    ? proxyUrl.startsWith("socks")
      ? new SocksProxyAgent(proxyUrl)
      : new HttpsProxyAgent(proxyUrl)
    : undefined;
  const client = url.startsWith("https") ? https : http;

  await new Promise<void>((resolve, reject) => {
    client
      .get(url, { agent }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`下载 HTTP ${res.statusCode}`));
          return;
        }
        const ws = createWriteStream(dest);
        res.pipe(ws);
        ws.on("finish", () => ws.close(() => resolve()));
        ws.on("error", reject);
      })
      .on("error", reject);
  });

  return dest;
}
