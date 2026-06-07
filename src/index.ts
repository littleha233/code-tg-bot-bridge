import { Telegraf } from "telegraf";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { loadConfig } from "./config";
import { registerCommandHandlers, registerCommandMenu } from "./commandHandlers";
import { CodexRunner } from "./codexRunner";
import { createLogger } from "./logger";
import { registerMessageHandler } from "./messageHandler";
import { ModelStore } from "./modelStore";
import { SessionStore } from "./sessionStore";
import { TaskStore } from "./taskStore";
import { WorkspaceStore } from "./workspaceStore";

const logger = createLogger("app");

async function main(): Promise<void> {
  const config = loadConfig();
  const taskStore = new TaskStore(config.tasksDir, config.logsDir);
  await taskStore.ensureReady();
  const modelStore = new ModelStore(config.modelsFile);
  const workspaceStore = new WorkspaceStore(config.workspacesFile);
  const sessionStore = new SessionStore(config.sessionsFile);

  logger.info("Preparing Telegram bot", {
    runCodexEnabled: config.runCodexEnabled,
    workspaceDir: config.codexWorkspaceDir,
    hasTelegramProxy: Boolean(config.telegramProxyUrl),
  });

  const bot = new Telegraf(config.telegramBotToken, {
    telegram: buildTelegramOptions(config.telegramProxyUrl),
  });

  logger.info("Fetching bot identity from Telegram");
  const botInfo = await bot.telegram.getMe();
  const botUsername = botInfo.username;
  const codexRunner = new CodexRunner(config);

  await registerCommandMenu(bot);
  registerCommandHandlers(bot, config, taskStore, modelStore, workspaceStore, sessionStore);
  registerMessageHandler(
    bot,
    config,
    taskStore,
    codexRunner,
    botUsername,
    modelStore,
    workspaceStore,
    sessionStore,
  );

  bot.catch((error, ctx) => {
    logger.error("Unhandled Telegraf error", {
      error: error instanceof Error ? error.message : String(error),
      updateType: ctx.updateType,
    });
  });

  process.on("SIGINT", () => {
    logger.warn("Received SIGINT, stopping bot");
    bot.stop("SIGINT");
  });

  process.on("SIGTERM", () => {
    logger.warn("Received SIGTERM, stopping bot");
    bot.stop("SIGTERM");
  });

  logger.info("Starting tg-codex-agent", {
    botUsername,
    runCodexEnabled: config.runCodexEnabled,
    workspaceDir: config.codexWorkspaceDir,
    telegramProxyUrl: config.telegramProxyUrl,
  });

  await bot.launch();
  logger.info("Telegram bot launched");
}

main().catch((error) => {
  logger.error("Failed to start bot", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

function buildTelegramOptions(proxyUrl: string | undefined): Record<string, unknown> {
  if (!proxyUrl) {
    return {};
  }

  const agent = proxyUrl.startsWith("socks")
    ? new SocksProxyAgent(proxyUrl)
    : new HttpsProxyAgent(proxyUrl);

  return { agent };
}
