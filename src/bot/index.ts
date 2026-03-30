import { Bot } from "grammy";
import { initUserSettingsDb } from "src/settings/user-settings";
import { config } from "src/utils/env-validation";
import { logError, logger } from "src/utils/logger";
import { downloadCommand } from "./commands/download";
import { musicCallbackQuery, musicCommand } from "./commands/music";
import { settingsCallbackQuery, settingsCommand } from "./commands/settings";

let botInstance: Bot | null = null;

function startupCheck() {
  const ffprobePath = Bun.which("ffprobe");
  const ytDlpPath = Bun.which("yt-dlp");
  const pinterestDlPath = Bun.which("pinterest-dl");
  const instaloaderPath = Bun.which("instaloader");

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

  if (!instaloaderPath) {
    logger.warn(
      "instaloader is not installed; instagram downloads will fail until it is available in PATH.",
    );
  }
}

function createBot() {
  startupCheck();
  initUserSettingsDb();

  const bot = new Bot(config.get("BOT_TOKEN"));

  bot.command("start", (ctx) =>
    ctx.reply(
      "hi.\n" +
        "this is a bot for downloading tiktoks without watermarks, youtube media, pinterest pins/boards, instagram posts/reels, and searched music. no ads, no spam, no sponsors.\n" +
        "send a tiktok/youtube/pinterest/instagram link and get the media.\n" +
        "use /music <query> to search tracks and download one as mp3.\n" +
        "use /settings to configure verbose output, tiktok providers, youtube preset, and music search provider.",
    ),
  );
  bot.command("settings", settingsCommand);
  bot.command("music", musicCommand);
  bot.callbackQuery(/^settings:/, settingsCallbackQuery);
  bot.callbackQuery(/^music:/, musicCallbackQuery);
  bot.on("message", downloadCommand);

  bot.catch((err) => {
    logError(err.error);
    logger.error(
      `bot middleware error while handling update ${String(err.ctx.update.update_id)}`,
    );
  });

  return bot;
}

export async function initBot() {
  if (!botInstance) {
    botInstance = createBot();
  }

  if (botInstance.isRunning()) {
    logger.warn("bot start requested while polling is already running");
    return;
  }

  try {
    await botInstance.start({
      drop_pending_updates: true,
      onStart: () => {
        logger.info("bot started and listening...");
      },
    });
  } catch (error) {
    logger.error("bot polling stopped unexpectedly");
    throw error;
  }
  logger.warn("bot polling stopped");
}
