import {
  InlineKeyboard,
  type CallbackQueryContext,
  type CommandContext,
  type Context,
} from "grammy";
import {
  ALL_DOWNLOAD_SOURCES,
  DownloadSource,
  type DownloadSource as DownloadSourceType,
} from "src/dl/downloader";
import {
  getUserSettings,
  updateUserDownloadSources,
  updateUserVerboseOutput,
} from "src/settings/user-settings";

const SETTINGS_CALLBACK_PREFIX = "settings";

const DOWNLOAD_SOURCE_DESCRIPTIONS: Record<DownloadSourceType, string> = {
  [DownloadSource.V1]:
    "`v1` - TikTok API scraper path from `@tobyg74/tiktok-api-dl`; alternate source.",
  [DownloadSource.V2]:
    "`v2` - `ssstik.io`; current default in this bot, generally the primary/stablest choice here.",
  [DownloadSource.V3]:
    "`v3` - `musicaldown.com`; alternate source, not recommended - very laggy",
};

function icon(enabled: boolean): string {
  return enabled ? "✅" : "❌";
}

function formatMainSettingsMessage(userId: number): string {
  const settings = getUserSettings(userId);

  return (
    `*settings*\n\n` +
    `verbose output controls whether the bot sends link details after successful downloads.\n` +
    `download sources let you choose which fetchers are used for new downloads.\n\n` +
    `*current*\n` +
    `verbose: ${settings.verboseOutput ? "on" : "off"}\n` +
    `sources: ${settings.downloadSources.join(", ")}`
  );
}

function formatSourcesMessage(userId: number): string {
  const settings = getUserSettings(userId);

  return (
    `*download sources*\n\n` +
    `these sources are different providers/fetchers for the same tiktok download.\n` +
    `enable the ones you want the bot to try for your downloads.\n` +
    `at least one source must stay enabled.\n\n` +
    `*current*: ${settings.downloadSources.join(", ")}\n\n` +
    `${DOWNLOAD_SOURCE_DESCRIPTIONS[DownloadSource.V1]}\n` +
    `${DOWNLOAD_SOURCE_DESCRIPTIONS[DownloadSource.V2]}\n` +
    `${DOWNLOAD_SOURCE_DESCRIPTIONS[DownloadSource.V3]}`
  );
}

function buildMainSettingsKeyboard(userId: number): InlineKeyboard {
  const settings = getUserSettings(userId);

  return new InlineKeyboard()
    .text(
      `verbose ${icon(settings.verboseOutput)}`,
      `${SETTINGS_CALLBACK_PREFIX}:toggle_verbose:${userId}`,
    )
    .row()
    .text("sources >>", `${SETTINGS_CALLBACK_PREFIX}:sources:${userId}`);
}

function buildSourcesKeyboard(userId: number): InlineKeyboard {
  const settings = getUserSettings(userId);
  const keyboard = new InlineKeyboard();

  for (const source of ALL_DOWNLOAD_SOURCES) {
    keyboard
      .text(
        `${source} ${icon(settings.downloadSources.includes(source))}`,
        `${SETTINGS_CALLBACK_PREFIX}:toggle_source:${userId}:${source}`,
      )
      .row();
  }

  return keyboard.text("back", `${SETTINGS_CALLBACK_PREFIX}:main:${userId}`);
}

async function editSettingsMessage(
  ctx: CallbackQueryContext<Context>,
  view: "main" | "sources",
  userId: number,
) {
  const text =
    view === "main"
      ? formatMainSettingsMessage(userId)
      : formatSourcesMessage(userId);
  const reply_markup =
    view === "main"
      ? buildMainSettingsKeyboard(userId)
      : buildSourcesKeyboard(userId);

  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup,
  });
}

function parseCallbackData(data: string):
  | { action: "main" | "sources" | "toggle_verbose"; userId: number }
  | {
      action: "toggle_source";
      userId: number;
      source: DownloadSourceType;
    }
  | null {
  const parts = data.split(":");
  if (parts[0] !== SETTINGS_CALLBACK_PREFIX) {
    return null;
  }

  const userId = Number(parts[2]);
  if (!Number.isInteger(userId)) {
    return null;
  }

  if (
    parts[1] === "main" ||
    parts[1] === "sources" ||
    parts[1] === "toggle_verbose"
  ) {
    return { action: parts[1], userId };
  }

  if (
    parts[1] === "toggle_source" &&
    parts[3] &&
    ALL_DOWNLOAD_SOURCES.includes(parts[3] as DownloadSource)
  ) {
    return {
      action: "toggle_source",
      userId,
      source: parts[3] as DownloadSourceType,
    };
  }

  return null;
}

export async function settingsCommand(ctx: CommandContext<Context>) {
  if (!ctx.from) {
    await ctx.reply("unable to resolve user");
    return;
  }

  await ctx.reply(formatMainSettingsMessage(ctx.from.id), {
    parse_mode: "Markdown",
    reply_markup: buildMainSettingsKeyboard(ctx.from.id),
  });
}

export async function settingsCallbackQuery(
  ctx: CallbackQueryContext<Context>,
) {
  const data = ctx.callbackQuery.data;
  const parsed = parseCallbackData(data);

  if (!parsed || !ctx.from) {
    await ctx.answerCallbackQuery();
    return;
  }

  if (ctx.from.id !== parsed.userId) {
    await ctx.answerCallbackQuery({
      text: "this settings menu belongs to another user",
      show_alert: true,
    });
    return;
  }

  if (parsed.action === "main" || parsed.action === "sources") {
    await editSettingsMessage(ctx, parsed.action, parsed.userId);
    await ctx.answerCallbackQuery();
    return;
  }

  if (parsed.action === "toggle_verbose") {
    const settings = getUserSettings(parsed.userId);
    updateUserVerboseOutput(parsed.userId, !settings.verboseOutput);
    await editSettingsMessage(ctx, "main", parsed.userId);
    await ctx.answerCallbackQuery();
    return;
  }

  if (parsed.action === "toggle_source") {
    const settings = getUserSettings(parsed.userId);
    const nextSources = settings.downloadSources.includes(parsed.source)
      ? settings.downloadSources.filter((source) => source !== parsed.source)
      : [...settings.downloadSources, parsed.source];

    try {
      updateUserDownloadSources(parsed.userId, nextSources);
      await editSettingsMessage(ctx, "sources", parsed.userId);
      await ctx.answerCallbackQuery();
    } catch {
      await ctx.answerCallbackQuery({
        text: "at least one source must stay enabled",
        show_alert: true,
      });
    }
  }
}
