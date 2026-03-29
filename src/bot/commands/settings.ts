import {
  InlineKeyboard,
  type CallbackQueryContext,
  type CommandContext,
  type Context,
} from "grammy";
import {
  ALL_TIKTOK_PROVIDERS,
  type TiktokProvider,
} from "src/dl/platforms/tiktok/types";
import {
  getUserSettings,
  updateUserTiktokProviders,
  updateUserVerboseOutput,
} from "src/settings/user-settings";

const SETTINGS_CALLBACK_PREFIX = "settings";

const TIKTOK_PROVIDER_DESCRIPTIONS: Record<TiktokProvider, string> = {
  v1: "`v1` - TikTok API scraper path from `@tobyg74/tiktok-api-dl`; alternate source.",
  v2: "`v2` - `ssstik.io`; current default in this bot, generally the primary/stablest choice here.",
  v3: "`v3` - `musicaldown.com`; alternate source, not recommended - very laggy",
};

function icon(enabled: boolean): string {
  return enabled ? "✅" : "❌";
}

function formatMainSettingsMessage(userId: number): string {
  const settings = getUserSettings(userId);

  return (
    `*settings*\n\n` +
    `verbose output controls whether the bot sends link details after successful downloads.\n` +
    `tiktok providers let you choose which internal extraction paths are used for tiktok downloads.\n\n` +
    `*current*\n` +
    `verbose: ${settings.verboseOutput ? "on" : "off"}\n` +
    `tiktok providers: ${settings.platformPreferences.tiktok.providers.join(", ")}`
  );
}

function formatProvidersMessage(userId: number): string {
  const settings = getUserSettings(userId);

  return (
    `*tiktok providers*\n\n` +
    `these providers are alternate extraction paths for the same tiktok download.\n` +
    `enable the ones you want the bot to try for tiktok links.\n` +
    `at least one provider must stay enabled.\n\n` +
    `*current*: ${settings.platformPreferences.tiktok.providers.join(", ")}\n\n` +
    `${TIKTOK_PROVIDER_DESCRIPTIONS.v1}\n` +
    `${TIKTOK_PROVIDER_DESCRIPTIONS.v2}\n` +
    `${TIKTOK_PROVIDER_DESCRIPTIONS.v3}`
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
    .text(
      "tiktok providers >>",
      `${SETTINGS_CALLBACK_PREFIX}:providers:${userId}`,
    );
}

function buildProvidersKeyboard(userId: number): InlineKeyboard {
  const settings = getUserSettings(userId);
  const enabledProviders = settings.platformPreferences.tiktok.providers;
  const keyboard = new InlineKeyboard();

  for (const provider of ALL_TIKTOK_PROVIDERS) {
    keyboard
      .text(
        `${provider} ${icon(enabledProviders.includes(provider))}`,
        `${SETTINGS_CALLBACK_PREFIX}:toggle_provider:${userId}:${provider}`,
      )
      .row();
  }

  return keyboard.text("back", `${SETTINGS_CALLBACK_PREFIX}:main:${userId}`);
}

async function editSettingsMessage(
  ctx: CallbackQueryContext<Context>,
  view: "main" | "providers",
  userId: number,
) {
  const text =
    view === "main"
      ? formatMainSettingsMessage(userId)
      : formatProvidersMessage(userId);
  const replyMarkup =
    view === "main"
      ? buildMainSettingsKeyboard(userId)
      : buildProvidersKeyboard(userId);

  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: replyMarkup,
  });
}

function parseCallbackData(data: string):
  | { action: "main" | "providers" | "toggle_verbose"; userId: number }
  | {
      action: "toggle_provider";
      userId: number;
      provider: TiktokProvider;
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
    parts[1] === "providers" ||
    parts[1] === "toggle_verbose"
  ) {
    return { action: parts[1], userId };
  }

  if (
    parts[1] === "toggle_provider" &&
    parts[3] &&
    ALL_TIKTOK_PROVIDERS.includes(parts[3] as TiktokProvider)
  ) {
    return {
      action: "toggle_provider",
      userId,
      provider: parts[3] as TiktokProvider,
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

  if (parsed.action === "main" || parsed.action === "providers") {
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

  if (parsed.action !== "toggle_provider") {
    await ctx.answerCallbackQuery();
    return;
  }

  const settings = getUserSettings(parsed.userId);
  const currentProviders = settings.platformPreferences.tiktok.providers;
  const nextProviders = currentProviders.includes(parsed.provider)
    ? currentProviders.filter((provider) => provider !== parsed.provider)
    : [...currentProviders, parsed.provider];

  try {
    updateUserTiktokProviders(parsed.userId, nextProviders);
    await editSettingsMessage(ctx, "providers", parsed.userId);
    await ctx.answerCallbackQuery();
  } catch {
    await ctx.answerCallbackQuery({
      text: "at least one provider must stay enabled",
      show_alert: true,
    });
  }
}
