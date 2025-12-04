import { Bot } from "grammy";
import { config } from "src/utils/env-validation";
import { logError, logger } from "src/utils/logger";
import { downloadCommand } from "./commands/download";

export function initBot() {
  const bot = new Bot(config.get("BOT_TOKEN"));

  bot.command("start", (ctx) =>
    ctx.reply(
      "hi.\n" +
        "this is a bot for downloading tiktoks without watermarks. no ads, no spam, no sponsors.\n" +
        "send a tiktok link and get the video.",
    ),
  );
  bot.on("message", downloadCommand);

  bot.catch(logError);

  bot.start({
    drop_pending_updates: true,
    onStart: () => {
      logger.info("bot started and listening...");
    },
  });
}
