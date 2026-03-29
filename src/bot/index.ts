import { Bot } from "grammy";
import { settingsCallbackQuery, settingsCommand } from "./commands/settings";
import { config } from "src/utils/env-validation";
import { logError, logger } from "src/utils/logger";
import { initUserSettingsDb } from "src/settings/user-settings";
import { downloadCommand } from "./commands/download";

function startupCheck() {
  const ffprobePath = Bun.which("ffprobe");
  const ytDlpPath = Bun.which("yt-dlp");
  const pinterestDlPath = Bun.which("pinterest-dl");

  if (!ffprobePath) {
    logger.crit(
      "ffprobe is not installed in the system, but is required. install it with `apt install ffmpeg`, then we'll talk...",
    );
    process.exit(1);
  }

  if (!ytDlpPath) {
    logger.warn(
      "yt-dlp is not installed; youtube downloads will fail until it is available in PATH.",
    );
  }

  if (!pinterestDlPath) {
    logger.warn(
      "pinterest-dl is not installed; pinterest downloads will fail until it is available in PATH.",
    );
  }
}

export function initBot() {
  startupCheck();
  initUserSettingsDb();

  const bot = new Bot(config.get("BOT_TOKEN"));

  bot.command("start", (ctx) =>
    ctx.reply(
      "hi.\n" +
        "this is a bot for downloading tiktoks without watermarks, youtube media, and pinterest pins/boards. no ads, no spam, no sponsors.\n" +
        "send a tiktok, youtube, or pinterest link and get the media.\n" +
        "use /settings to configure verbose output, tiktok providers, and youtube preset.",
    ),
  );
  bot.command("settings", settingsCommand);
  bot.callbackQuery(/^settings:/, settingsCallbackQuery);
  bot.on("message", downloadCommand);

  bot.catch(logError);

  bot.start({
    drop_pending_updates: true,
    onStart: () => {
      logger.info("bot started and listening...");
    },
  });
}
