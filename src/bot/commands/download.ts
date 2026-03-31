import {
  InputFile,
  InputMediaBuilder,
  type Context,
  type Filter,
  type MiddlewareFn,
} from "grammy";
import { finishUserJob, tryStartUserJob } from "src/bot/active-job-limiter";
import {
  checkUserJobRateLimit,
  formatUserJobRateLimitMessage,
  recordUserJobStart,
} from "src/bot/user-job-rate-limiter";
import {
  downloadContent,
  type GalleryEntry,
  type MusicVariant,
  type VideoVariant,
} from "src/dl/downloader";
import type { DownloadProgress } from "src/dl/types";
import { toDownloadError } from "src/errors/download-error";
import {
  getDefaultUserSettings,
  getUserSettings,
} from "src/settings/user-settings";
import { chunkArray } from "src/utils/array";
import { config } from "src/utils/env-validation";
import { logError, logger } from "src/utils/logger";
import { isHttpURL } from "src/utils/utils";
import {
  buildGalleryLinksMessages,
  buildImageLinksMessages,
  buildSingleMediaLinksMessage,
  generateMusicLinksEntry,
  generateVideoLinksEntry,
  sendChunkedLinks,
} from "./download-presentation";
import { musicSearchFromMessage, shouldFallbackToMusicSearch } from "./music";

const MAX_MEDIA_GROUP_SIZE = 10;

function deleteMessageSafe(
  ctx: Filter<Context, "message">,
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
    } else if (remainder > 0) {
      bar += "░";
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

function createProgressUpdater(
  ctx: Filter<Context, "message">,
  loadingMessage: { chat: { id: number }; message_id: number },
) {
  const progressUpdateIntervalMs = config.get(
    "BOT_PROGRESS_UPDATE_INTERVAL_MS",
  );
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
    } else if (progress.stage === "batch") {
      const percent =
        progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
      nextText =
        `${progress.message}\n` +
        `\`${formatProgressBar(percent)}\` ${progress.current}/${progress.total}`;
    } else if (progress.stage === "postprocess") {
      nextText = `processing...\n${progress.message}`;
    } else {
      nextText = progress.message;
    }

    const now = Date.now();
    if (
      nextText === lastText ||
      (now - lastSentAt < progressUpdateIntervalMs &&
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

type GalleryUploadableMedia = {
  index: number;
  media:
    | ReturnType<typeof InputMediaBuilder.photo>
    | ReturnType<typeof InputMediaBuilder.video>;
};

function getGalleryUploadableMedia(entries: GalleryEntry[]) {
  const media: GalleryUploadableMedia[] = [];

  entries.forEach((entry, index) => {
    if (entry.kind === "image") {
      const uploaded = entry.variants.find(
        (variant): variant is Extract<typeof variant, { downloaded: true }> =>
          variant.downloaded,
      );
      if (!uploaded) {
        return;
      }

      media.push({
        index,
        media: InputMediaBuilder.photo(new InputFile(uploaded.path)),
      });
      return;
    }

    const uploaded = entry.variants.find(
      (variant): variant is Extract<typeof variant, { downloaded: true }> =>
        variant.downloaded &&
        variant.size <= config.get("BOT_MAX_FILE_SIZE_MB") * 1024 * 1024,
    );
    if (!uploaded) {
      return;
    }

    media.push({
      index,
      media: InputMediaBuilder.video(new InputFile(uploaded.path)),
    });
  });

  return media;
}

async function sendSingleMediaResult<T extends VideoVariant | MusicVariant>({
  ctx,
  loadingMessage,
  progressText,
  fallbackText,
  uploadFailureText,
  uploadAction,
  variants,
  links,
  verboseOutput,
  cleanup,
  sendMedia,
}: {
  ctx: Filter<Context, "message">;
  loadingMessage: { chat: { id: number }; message_id: number };
  progressText: string;
  fallbackText: string;
  uploadFailureText: string;
  uploadAction: "upload_video" | "upload_voice";
  variants: T[];
  links: string[];
  verboseOutput: boolean;
  cleanup: () => void;
  sendMedia: (variant: Extract<T, { downloaded: true }>) => Promise<unknown>;
}): Promise<void> {
  const maxFileSizeMb = config.get("BOT_MAX_FILE_SIZE_MB");
  const maxFileSize = maxFileSizeMb * 1024 * 1024;
  const validFiles = variants
    .filter((file): file is Extract<T, { downloaded: true }> => file.downloaded)
    .filter((file) => file.size <= maxFileSize);

  if (!validFiles.length) {
    logger.warn(`no valid files found (max size exceeded or download failed)`);
    deleteMessageSafe(ctx, loadingMessage);
    await ctx.reply(fallbackText);
    await sendChunkedLinks(ctx, links);
    cleanup();
    return;
  }

  const progressMessage = await ctx.reply(progressText);
  let uploadFailed = false;
  try {
    await ctx.api.sendChatAction(loadingMessage.chat.id, uploadAction);
    await sendMedia(validFiles[0]!);
  } catch (err) {
    uploadFailed = true;
    logError(err);
  } finally {
    cleanup();
    deleteMessageSafe(ctx, loadingMessage);
    deleteMessageSafe(ctx, progressMessage);
  }

  if (uploadFailed) {
    await ctx.reply(uploadFailureText);
    await sendChunkedLinks(ctx, links);
    return;
  }

  if (verboseOutput) {
    await sendChunkedLinks(ctx, [buildSingleMediaLinksMessage(links)]);
  }
}

export const downloadCommand: MiddlewareFn<Filter<Context, "message">> = async (
  ctx,
  next,
) => {
  const maxFileSizeMb = config.get("BOT_MAX_FILE_SIZE_MB");
  const maxFileSize = maxFileSizeMb * 1024 * 1024;
  const maxActiveJobsPerUser = config.get("BOT_MAX_ACTIVE_JOBS_PER_USER");
  const query = ctx.message.text;
  if (!query) {
    await next();
    return;
  }

  if (!isHttpURL(query)) {
    if (shouldFallbackToMusicSearch(query)) {
      await musicSearchFromMessage(ctx, query.trim());
      return;
    }

    await next();
    return;
  }

  if (ctx.from) {
    const rateLimitResult = checkUserJobRateLimit(ctx.from.id);
    if (!rateLimitResult.allowed) {
      logger.warn(
        `user ${ctx.from.id} hit ${rateLimitResult.window} heavy-job rate limit; retryAfterMs=${rateLimitResult.retryAfterMs}`,
      );
      await ctx.reply(formatUserJobRateLimitMessage(rateLimitResult));
      return;
    }
  }

  if (ctx.from && !tryStartUserJob(ctx.from.id)) {
    await ctx.reply(
      `you already have ${maxActiveJobsPerUser} active jobs. wait for one to finish before starting another.`,
    );
    return;
  }

  if (ctx.from) {
    recordUserJobStart(ctx.from.id);
  }

  const msg1 = await ctx.reply(`downloading...`);
  const userSettings = ctx.from
    ? getUserSettings(ctx.from.id)
    : getDefaultUserSettings();
  const downloadStrategy = userSettings.verboseOutput ? "all" : "single";
  const progressUpdater = createProgressUpdater(ctx, msg1);

  try {
    const { res, cleanup } = await downloadContent(
      query,
      {
        tiktokProviders: userSettings.platformPreferences.tiktok.providers,
        youtubePreset: userSettings.platformPreferences.youtube.preset,
      },
      {
        strategy: downloadStrategy,
        maxFileSize,
        onProgress: progressUpdater,
      },
    );

    if (res.contentType === "video") {
      const uploadedFile = res.variants.find(
        (file): file is Extract<VideoVariant, { downloaded: true }> =>
          file.downloaded && file.size <= maxFileSize,
      );
      const links = res.variants.map((file) =>
        generateVideoLinksEntry(file, uploadedFile),
      );
      await sendSingleMediaResult({
        ctx,
        loadingMessage: msg1,
        progressText: `video downloaded, sending...`,
        fallbackText: `video was downloaded, but it exceeds ${maxFileSizeMb}mb and Telegram doesn't allow sending such big files.`,
        uploadFailureText: `video was downloaded, but Telegram rejected the upload. sending links instead.`,
        uploadAction: "upload_video",
        variants: res.variants,
        links,
        verboseOutput: userSettings.verboseOutput,
        cleanup,
        sendMedia: (variant) =>
          ctx.replyWithVideo(new InputFile(variant.path), {
            width: variant.payload.resolution.width,
            height: variant.payload.resolution.height,
            duration: variant.payload.durationSeconds,
            supports_streaming: true,
          }),
      });

      logger.info(`sent video ${query} to ${ctx.from?.id ?? "unknown user"}`);
    } else if (res.contentType === "image") {
      const msg2 = await ctx.reply(
        res.variants.length > 1
          ? `images downloaded, sending... (${res.variants.length} versions)`
          : `image downloaded, sending... (1 version)`,
      );
      await ctx.api.sendChatAction(msg1.chat.id, "upload_photo");
      const imageLinks = buildImageLinksMessages(res.variants);

      const media = res.variants
        .filter((variants) => variants.length)
        .map((variants) => {
          const downloaded = variants.filter((variant) => variant.downloaded);
          return InputMediaBuilder.photo(
            new InputFile(
              downloaded.length
                ? downloaded[0]!.path
                : variants[0]!.downloadUrl,
            ),
          );
        });
      let uploadFailed = false;
      try {
        for (const chunk of chunkArray(media, MAX_MEDIA_GROUP_SIZE)) {
          await ctx.replyWithMediaGroup(chunk);
        }
      } catch (err) {
        uploadFailed = true;
        logError(err);
      } finally {
        cleanup();
        deleteMessageSafe(ctx, msg1);
        deleteMessageSafe(ctx, msg2);
      }

      if (uploadFailed) {
        await ctx.reply(
          `images were downloaded, but Telegram rejected the upload. sending links instead.`,
        );
        await sendChunkedLinks(ctx, imageLinks);
        await next();
        return;
      }

      if (userSettings.verboseOutput) {
        await sendChunkedLinks(ctx, imageLinks);
      }
    } else if (res.contentType === "music") {
      const uploadedFile = res.variants.find(
        (file): file is Extract<MusicVariant, { downloaded: true }> =>
          file.downloaded && file.size <= maxFileSize,
      );
      const links = res.variants.map((file) =>
        generateMusicLinksEntry(file, uploadedFile),
      );
      await sendSingleMediaResult({
        ctx,
        loadingMessage: msg1,
        progressText: `music downloaded, sending...`,
        fallbackText: `music was downloaded, but it exceeds ${maxFileSizeMb}mb and Telegram doesn't allow sending such big files.`,
        uploadFailureText: `music was downloaded, but Telegram rejected the upload. sending links instead.`,
        uploadAction: "upload_voice",
        variants: res.variants,
        links,
        verboseOutput: userSettings.verboseOutput,
        cleanup,
        sendMedia: (variant) =>
          ctx.replyWithAudio(
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
          ),
      });

      logger.info(`sent audio ${query} to ${ctx.from?.id ?? "unknown user"}`);
    } else if (res.contentType === "gallery") {
      const msg2 = await ctx.reply(
        `pinterest items downloaded, sending... (${res.entries.length} items)`,
      );
      const galleryLinks = buildGalleryLinksMessages(res.entries);
      const uploadableMedia = getGalleryUploadableMedia(res.entries);
      const skippedIndexes = new Set(
        res.entries
          .map((_, index) => index)
          .filter(
            (index) => !uploadableMedia.some((entry) => entry.index === index),
          ),
      );

      if (!uploadableMedia.length) {
        cleanup();
        deleteMessageSafe(ctx, msg1);
        deleteMessageSafe(ctx, msg2);
        await ctx.reply(
          `pinterest items were resolved, but nothing uploadable was produced. sending links instead.`,
        );
        await sendChunkedLinks(ctx, galleryLinks);
        await next();
        return;
      }

      let uploadFailed = false;
      try {
        await ctx.api.sendChatAction(msg1.chat.id, "upload_photo");
        for (const chunk of chunkArray(uploadableMedia, MAX_MEDIA_GROUP_SIZE)) {
          await ctx.replyWithMediaGroup(chunk.map((entry) => entry.media));
        }
      } catch (err) {
        uploadFailed = true;
        logError(err);
      } finally {
        cleanup();
        deleteMessageSafe(ctx, msg1);
        deleteMessageSafe(ctx, msg2);
      }

      if (uploadFailed) {
        await ctx.reply(
          `pinterest items were downloaded, but Telegram rejected the upload. sending links instead.`,
        );
        await sendChunkedLinks(ctx, galleryLinks);
        await next();
        return;
      }

      if (skippedIndexes.size) {
        await ctx.reply(
          `some pinterest items could not be uploaded. sending links for the skipped items.`,
        );
        await sendChunkedLinks(
          ctx,
          galleryLinks.filter((_, index) => skippedIndexes.has(index)),
        );
      }

      if (userSettings.verboseOutput) {
        await sendChunkedLinks(ctx, galleryLinks);
      }
    }

    await next();
  } catch (err) {
    logError(err);
    const errMsg = toDownloadError(err).message;
    ctx.api.deleteMessage(msg1.chat.id, msg1.message_id).catch();
    ctx.reply(`failed to download: ${errMsg}`);
    await next();
  } finally {
    if (ctx.from) {
      finishUserJob(ctx.from.id);
    }
  }
};
