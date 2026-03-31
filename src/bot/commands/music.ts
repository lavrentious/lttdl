import { randomUUIDv7 } from "bun";
import {
  InlineKeyboard,
  InputFile,
  type CallbackQueryContext,
  type CommandContext,
  type Context,
  type Filter,
} from "grammy";
import { finishUserJob, tryStartUserJob } from "src/bot/active-job-limiter";
import {
  checkUserJobRateLimit,
  formatUserJobRateLimitMessage,
  recordUserJobStart,
} from "src/bot/user-job-rate-limiter";
import {
  downloadMusicResult,
  searchMusic,
  type MusicSearchResult,
} from "src/dl/music";
import type { DownloadProgress, MusicVariant } from "src/dl/types";
import { DownloadError, toDownloadError } from "src/errors/download-error";
import { getUserSettings } from "src/settings/user-settings";
import { logError, logger } from "src/utils/logger";
import { escapeMarkdownV2 } from "src/utils/utils";
import {
  buildSingleMediaLinksMessage,
  generateMusicLinksEntry,
  sendChunkedLinks,
} from "./download-presentation";

const MUSIC_CALLBACK_PREFIX = "music";
const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;
const MUSIC_PAGE_SIZE = 5;
const MUSIC_SEARCH_LIMIT = 20;
const PROGRESS_UPDATE_INTERVAL_MS = 1200;
const SEARCH_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_JOBS_PER_USER = 4;

type PendingMusicSearch = {
  userId: number;
  query: string;
  provider: ReturnType<
    typeof getUserSettings
  >["platformPreferences"]["music"]["searchProvider"];
  results: MusicSearchResult[];
  expiresAt: number;
};

const pendingSearches = new Map<string, PendingMusicSearch>();

function cleanupExpiredSearches() {
  const now = Date.now();
  for (const [token, entry] of pendingSearches.entries()) {
    if (entry.expiresAt <= now) {
      pendingSearches.delete(token);
    }
  }
}

function deleteMessageSafe(
  ctx: Context,
  message?: { chat: { id: number }; message_id: number },
) {
  if (!message) return;
  ctx.api.deleteMessage(message.chat.id, message.message_id).catch();
}

function formatProgressBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const segments = 10;
  let remainder = (clamped / 100) * segments;
  let bar = "";

  for (let i = 0; i < segments; i++) {
    if (remainder >= 1) {
      bar += "█";
    } else if (remainder >= 0.75) {
      bar += "▓";
    } else if (remainder >= 0.5) {
      bar += "▒";
    } else {
      bar += "░";
    }

    remainder -= 1;
  }

  return bar;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(durationSeconds?: number): string {
  if (!durationSeconds || durationSeconds < 1) {
    return "?";
  }

  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function truncateLabel(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

function escapeMarkdownV2Url(url: string): string {
  return url.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}

function getPageCount(results: MusicSearchResult[]): number {
  return Math.max(1, Math.ceil(results.length / MUSIC_PAGE_SIZE));
}

function clampPage(page: number, results: MusicSearchResult[]): number {
  return Math.max(0, Math.min(page, getPageCount(results) - 1));
}

function getPageResults(
  results: MusicSearchResult[],
  page: number,
): MusicSearchResult[] {
  const normalizedPage = clampPage(page, results);
  const start = normalizedPage * MUSIC_PAGE_SIZE;
  return results.slice(start, start + MUSIC_PAGE_SIZE);
}

function createProgressUpdater(
  ctx: Context,
  loadingMessage: { chat: { id: number }; message_id: number },
) {
  let lastSentAt = 0;
  let lastText = "downloading...";

  return async (progress: DownloadProgress) => {
    let nextText: string;
    if (progress.stage === "status") {
      nextText = progress.message;
    } else if (progress.stage === "download") {
      const hasPercent = Number.isFinite(progress.percent);
      const percent = hasPercent
        ? Math.max(0, Math.min(100, progress.percent ?? 0))
        : undefined;
      const lines = [progress.message || "downloading..."];

      if (typeof percent === "number") {
        lines.push(`\`${formatProgressBar(percent)}\` ${percent.toFixed(1)}%`);
      }

      if (typeof progress.bytesDownloaded === "number") {
        const sizeText =
          typeof progress.totalBytes === "number"
            ? `${formatMegabytes(progress.bytesDownloaded)} / ${formatMegabytes(progress.totalBytes)}`
            : formatMegabytes(progress.bytesDownloaded);
        lines.push(sizeText);
      }

      if (progress.speed) {
        lines.push(`speed: ${progress.speed}`);
      }

      if (progress.eta) {
        lines.push(`eta: ${progress.eta}`);
      }

      nextText = lines.join("\n");
    } else if (progress.stage === "postprocess") {
      nextText = `processing...\n${progress.message}`;
    } else {
      nextText = progress.message;
    }

    const now = Date.now();
    if (
      nextText === lastText ||
      (now - lastSentAt < PROGRESS_UPDATE_INTERVAL_MS &&
        progress.stage === "download" &&
        (progress.percent ?? 0) < 100)
    ) {
      return;
    }

    lastSentAt = now;
    lastText = nextText;
    await ctx.api
      .editMessageText(
        loadingMessage.chat.id,
        loadingMessage.message_id,
        nextText,
        {
          parse_mode: "Markdown",
        },
      )
      .catch();
  };
}

async function sendMusicResult(params: {
  ctx: CallbackQueryContext<Context>;
  loadingMessage: { chat: { id: number }; message_id: number };
  variants: MusicVariant[];
  verboseOutput: boolean;
  cleanup: () => void;
}) {
  const { ctx, loadingMessage, variants, verboseOutput, cleanup } = params;
  const validFiles = variants
    .filter(
      (file): file is Extract<MusicVariant, { downloaded: true }> =>
        file.downloaded,
    )
    .filter((file) => file.size <= MAX_FILE_SIZE);
  const links = variants.map((file) =>
    generateMusicLinksEntry(file, validFiles[0]),
  );

  if (!validFiles.length) {
    deleteMessageSafe(ctx, loadingMessage);
    await ctx.reply(
      `music was downloaded, but it exceeds ${MAX_FILE_SIZE_MB}mb and Telegram doesn't allow sending such big files.`,
    );
    await sendChunkedLinks(ctx, links);
    cleanup();
    return;
  }

  const progressMessage = await ctx.reply("music downloaded, sending...");
  let uploadFailed = false;
  try {
    await ctx.api.sendChatAction(loadingMessage.chat.id, "upload_voice");
    const variant = validFiles[0]!;
    await ctx.replyWithAudio(
      new InputFile(
        variant.path,
        variant.payload.filename || variant.payload.name,
      ),
      {
        duration: variant.payload.durationSeconds,
        title: variant.payload.name,
        performer: variant.payload.performer,
        thumbnail: variant.payload.thumbnailPath
          ? new InputFile(variant.payload.thumbnailPath)
          : undefined,
      },
    );
  } catch (err) {
    uploadFailed = true;
    logError(err);
  } finally {
    cleanup();
    deleteMessageSafe(ctx, loadingMessage);
    deleteMessageSafe(ctx, progressMessage);
  }

  if (uploadFailed) {
    await ctx.reply(
      "music was downloaded, but Telegram rejected the upload. sending links instead.",
    );
    await sendChunkedLinks(ctx, links);
    return;
  }

  if (verboseOutput) {
    await sendChunkedLinks(ctx, [buildSingleMediaLinksMessage(links)]);
  }
}

function buildSearchKeyboard(
  userId: number,
  token: string,
  results: MusicSearchResult[],
  page: number,
) {
  const keyboard = new InlineKeyboard();
  const normalizedPage = clampPage(page, results);
  const offset = normalizedPage * MUSIC_PAGE_SIZE;

  getPageResults(results, normalizedPage).forEach((result, index) => {
    const duration = formatDuration(result.durationSeconds);
    const resultIndex = offset + index;
    const label = truncateLabel(
      `${resultIndex + 1}. ${result.title} [${duration}]`,
      64,
    );
    keyboard
      .text(
        label,
        `${MUSIC_CALLBACK_PREFIX}:pick:${userId}:${token}:${resultIndex}`,
      )
      .row();
  });

  if (getPageCount(results) > 1) {
    if (normalizedPage > 0) {
      keyboard.text(
        "‹ prev",
        `${MUSIC_CALLBACK_PREFIX}:page:${userId}:${token}:${normalizedPage - 1}`,
      );
    }
    keyboard.text(
      `${normalizedPage + 1}/${getPageCount(results)}`,
      `${MUSIC_CALLBACK_PREFIX}:noop:${userId}:${token}:${normalizedPage}`,
    );
    if (normalizedPage < getPageCount(results) - 1) {
      keyboard.text(
        "next ›",
        `${MUSIC_CALLBACK_PREFIX}:page:${userId}:${token}:${normalizedPage + 1}`,
      );
    }
    keyboard.row();
  }

  return keyboard;
}

function buildSearchMessage(
  query: string,
  results: MusicSearchResult[],
  page: number,
) {
  const normalizedPage = clampPage(page, results);
  const footer = `page ${normalizedPage + 1}/${getPageCount(results)} - ${results.length} result${
    results.length === 1 ? "" : "s"
  }`;
  return [
    `results for \`${escapeMarkdownV2(query)}\``,
    "",
    ...getPageResults(results, normalizedPage).map((result, index) => {
      const resultIndex = normalizedPage * MUSIC_PAGE_SIZE + index;
      const details = [result.uploader, formatDuration(result.durationSeconds)]
        .filter(Boolean)
        .join(" · ");
      const escapedTitle = escapeMarkdownV2(result.title);
      const escapedDetails = details ? escapeMarkdownV2(details) : "";
      return `${escapeMarkdownV2(`${resultIndex + 1}. `)}[${escapedTitle}](${escapeMarkdownV2Url(result.url)})${
        escapedDetails ? `\n   ${escapedDetails}` : ""
      }`;
    }),
    "",
    `_${escapeMarkdownV2(footer)}_`,
  ].join("\n");
}

function parseMusicCommandQuery(ctx: CommandContext<Context>): string {
  const text = ctx.message?.text || "";
  return text.replace(/^\/music(?:@\S+)?\s*/i, "").trim();
}

export function shouldFallbackToMusicSearch(text: string): boolean {
  const query = text.trim();
  return query.length > 0 && !query.startsWith("/");
}

function parseCallbackData(data: string):
  | {
      action: "pick";
      userId: number;
      token: string;
      index: number;
    }
  | {
      action: "page" | "noop";
      userId: number;
      token: string;
      page: number;
    }
  | null {
  const parts = data.split(":");
  if (parts[0] !== MUSIC_CALLBACK_PREFIX) {
    return null;
  }

  const userId = Number(parts[2]);
  const value = Number(parts[4]);
  if (!Number.isInteger(userId) || !parts[3] || !Number.isInteger(value)) {
    return null;
  }

  if (parts[1] === "pick") {
    return {
      action: "pick",
      userId,
      token: parts[3],
      index: value,
    };
  }

  if (parts[1] === "page" || parts[1] === "noop") {
    return {
      action: parts[1],
      userId,
      token: parts[3],
      page: value,
    };
  }

  return null;
}

async function editSearchPage(
  ctx: CallbackQueryContext<Context>,
  pending: PendingMusicSearch,
  token: string,
  page: number,
) {
  const normalizedPage = clampPage(page, pending.results);
  await ctx.editMessageText(
    buildSearchMessage(pending.query, pending.results, normalizedPage),
    {
      parse_mode: "MarkdownV2",
      reply_markup: buildSearchKeyboard(
        pending.userId,
        token,
        pending.results,
        normalizedPage,
      ),
    },
  );
}

async function runMusicSearch(
  ctx: CommandContext<Context> | Filter<Context, "message">,
  query: string,
) {
  if (!ctx.from) {
    await ctx.reply("unable to resolve user");
    return;
  }

  cleanupExpiredSearches();

  const rateLimitResult = checkUserJobRateLimit(ctx.from.id);
  if (!rateLimitResult.allowed) {
    logger.warn(
      `user ${ctx.from.id} hit ${rateLimitResult.window} heavy-job rate limit; retryAfterMs=${rateLimitResult.retryAfterMs}`,
    );
    await ctx.reply(formatUserJobRateLimitMessage(rateLimitResult));
    return;
  }

  if (!tryStartUserJob(ctx.from.id, MAX_ACTIVE_JOBS_PER_USER)) {
    await ctx.reply(
      `you already have ${MAX_ACTIVE_JOBS_PER_USER} active jobs. wait for one to finish before starting another.`,
    );
    return;
  }

  recordUserJobStart(ctx.from.id);

  const loadingMessage = await ctx.reply("searching music...");
  const userSettings = getUserSettings(ctx.from.id);
  const provider = userSettings.platformPreferences.music.searchProvider;

  try {
    const results = await searchMusic(provider, query, MUSIC_SEARCH_LIMIT);
    const token = randomUUIDv7();
    pendingSearches.set(token, {
      userId: ctx.from.id,
      query,
      provider,
      results,
      expiresAt: Date.now() + SEARCH_TTL_MS,
    });

    deleteMessageSafe(ctx, loadingMessage);
    await ctx.reply(buildSearchMessage(query, results, 0), {
      parse_mode: "MarkdownV2",
      reply_markup: buildSearchKeyboard(ctx.from.id, token, results, 0),
    });
  } catch (err) {
    logError(err);
    deleteMessageSafe(ctx, loadingMessage);
    const errMsg = toDownloadError(err).message;
    await ctx.reply(`failed to search music: ${errMsg}`);
  } finally {
    finishUserJob(ctx.from.id);
  }
}

export async function musicCommand(ctx: CommandContext<Context>) {
  const query = parseMusicCommandQuery(ctx);
  if (!query) {
    await ctx.reply("usage: /music <song or artist>");
    return;
  }

  await runMusicSearch(ctx, query);
}

export async function musicSearchFromMessage(
  ctx: Filter<Context, "message">,
  query: string,
) {
  await runMusicSearch(ctx, query);
}

export async function musicCallbackQuery(ctx: CallbackQueryContext<Context>) {
  cleanupExpiredSearches();

  const data = parseCallbackData(ctx.callbackQuery.data);
  if (!data || !ctx.from) {
    await ctx.answerCallbackQuery();
    return;
  }

  if (ctx.from.id !== data.userId) {
    await ctx.answerCallbackQuery({
      text: "this music search belongs to another user",
      show_alert: true,
    });
    return;
  }

  const pending = pendingSearches.get(data.token);
  if (!pending || pending.expiresAt <= Date.now()) {
    pendingSearches.delete(data.token);
    await ctx.answerCallbackQuery({
      text: "this music search expired, run /music again",
      show_alert: true,
    });
    return;
  }

  pending.expiresAt = Date.now() + SEARCH_TTL_MS;

  if (data.action === "noop") {
    await ctx.answerCallbackQuery();
    return;
  }

  if (data.action === "page") {
    await editSearchPage(ctx, pending, data.token, data.page).catch(
      async () => {
        await ctx.answerCallbackQuery({
          text: "failed to change page",
          show_alert: true,
        });
      },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  if (data.action !== "pick") {
    await ctx.answerCallbackQuery();
    return;
  }

  const selected = pending.results[data.index];
  if (!selected) {
    await ctx.answerCallbackQuery({
      text: "selected result is no longer available",
      show_alert: true,
    });
    return;
  }

  const rateLimitResult = checkUserJobRateLimit(ctx.from.id);
  if (!rateLimitResult.allowed) {
    logger.warn(
      `user ${ctx.from.id} hit ${rateLimitResult.window} heavy-job rate limit; retryAfterMs=${rateLimitResult.retryAfterMs}`,
    );
    await ctx.answerCallbackQuery({
      text: formatUserJobRateLimitMessage(rateLimitResult),
      show_alert: true,
    });
    return;
  }

  if (!tryStartUserJob(ctx.from.id, MAX_ACTIVE_JOBS_PER_USER)) {
    await ctx.reply(
      `you already have ${MAX_ACTIVE_JOBS_PER_USER} active jobs. wait for one to finish before starting another.`,
    );
    return;
  }

  recordUserJobStart(ctx.from.id);

  await ctx.answerCallbackQuery({
    text: `downloading ${truncateLabel(selected.title, 40)}`,
  });

  pendingSearches.delete(data.token);
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch();

  const loadingMessage = await ctx.reply(`downloading ${selected.title}...`);
  const progressUpdater = createProgressUpdater(ctx, loadingMessage);
  const userSettings = getUserSettings(data.userId);

  try {
    const { res, cleanup } = await downloadMusicResult(
      pending.provider,
      selected,
      {
        maxFileSize: MAX_FILE_SIZE,
        onProgress: progressUpdater,
      },
    );

    if (res.contentType !== "music") {
      throw new DownloadError("music provider returned an invalid result");
    }

    await sendMusicResult({
      ctx,
      loadingMessage,
      variants: res.variants,
      verboseOutput: userSettings.verboseOutput,
      cleanup,
    });

    logger.info(`sent music ${selected.url} to ${ctx.from.id}`);
  } catch (err) {
    logError(err);
    deleteMessageSafe(ctx, loadingMessage);
    const errMsg = toDownloadError(err).message;
    await ctx.reply(`failed to download: ${errMsg}`);
  } finally {
    finishUserJob(ctx.from.id);
  }
}
