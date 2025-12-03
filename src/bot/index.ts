import { Bot } from "grammy";
import { config } from "src/utils/env-validation";
import { logError, logger } from "src/utils/logger";
import { downloadCommand } from "./commands/download";

export function initBot() {
  const bot = new Bot(config.get("BOT_TOKEN"));

  bot.command("start", (ctx) => ctx.reply("Welcome! Up and running."));
  bot.on("message", downloadCommand);

  bot.catch(logError);

  bot.start({
    onStart: () => {
      logger.info("bot started and listening...");
    },
  });
}
