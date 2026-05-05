import {
  InputFile,
  InputMediaBuilder,
  type Context,
  type Filter,
  type MiddlewareFn,
} from "grammy";
import { finishUserJob, tryStartUserJob } from "src/bot/active-job-limiter";
import {
  attachOperationMessage,
  completeTrackedOperation,
  createTrackedOperation,
  getCancelKeyboard,
  isTrackedOperationCancelled,
} from "src/bot/operation-registry";
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
import {
  getUserFacingDownloadErrorMessage,
  isCancelledError,
} from "src/errors/download-error";
import { createAndShareZip, shareFile } from "src/file-share/file-share";
import {
  getDefaultUserSettings,
  getUserSettings,
} from "src/settings/user-settings";
import { chunkArray } from "src/utils/array";
import { config } from "src/utils/env-validation";
import { logError, logger } from "src/utils/logger";
import { extractHttpURL, isHttpURL } from "src/utils/utils";
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

async function sendShareUrls(
  ctx: Filter<Context, "message">,
  urls: string[],
): Promise<void> {
  if (!urls.length) return;
  const ttlS = config.get("FILE_SHARE_TTL_S");
  const ttlLabel =
    ttlS >= 3600
      ? `${Math.round(ttlS / 3600)}h`
      : `${Math.round(ttlS / 60)}min`;
  const lines = urls.map((u) => `<a href="${u}">${u}</a>`).join("\n");
  await ctx.reply(
    `direct download link${urls.length > 1 ? "s" : ""} (expires in ${ttlLabel}):\n${lines}`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
}

async function sendGalleryShareUrls(
  ctx: Filter<Context, "message">,
  results: Array<{ label: number; url: string }>,
  zipUrl: string | null,
): Promise<void> {
  if (!results.length && !zipUrl) return;
  const ttlS = config.get("FILE_SHARE_TTL_S");
  const ttlLabel =
    ttlS >= 3600
      ? `${Math.round(ttlS / 3600)}h`
      : `${Math.round(ttlS / 60)}min`;
    
  const lines = results.map(
    ({ label, url }) => `${label}. <a href="${url}">${url}</a>`,
  );
  if (zipUrl) lines.push(`\nzip: <a href="${zipUrl}">${zipUrl}</a>`);
  await ctx.reply(
    `direct download links (expires in ${ttlLabel}):\n${lines.join("\n")}`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
}

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
  operationId: string,
) {
  const progressUpdateIntervalMs = config.get(
    "BOT_PROGRESS_UPDATE_INTERVAL_MS",
  );
  let lastSentAt = 0;
  let lastText = "downloading...";

  return async (progress: DownloadProgress) => {
    if (isTrackedOperationCancelled(operationId)) {
      return;
    }

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
          reply_markup: getCancelKeyboard(operationId),
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
  onBeforeCleanup,
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
  onBeforeCleanup?: (paths: string[], uploadFailed: boolean) => Promise<void>;
  sendMedia: (variant: Extract<T, { downloaded: true }>) => Promise<unknown>;
}): Promise<void> {
  const maxFileSizeMb = config.get("BOT_MAX_FILE_SIZE_MB");
  const maxFileSize = maxFileSizeMb * 1024 * 1024;
  const allDownloadedPaths = variants
    .filter((v): v is Extract<T, { downloaded: true }> => v.downloaded)
    .map((v) => v.path);
  const validFiles = variants
    .filter((file): file is Extract<T, { downloaded: true }> => file.downloaded)
    .filter((file) => file.size <= maxFileSize);

  if (!validFiles.length) {
    logger.warn(`no valid files found (max size exceeded or download failed)`);
    deleteMessageSafe(ctx, loadingMessage);
    await ctx.reply(fallbackText);
    await sendChunkedLinks(ctx, links);
    await onBeforeCleanup?.(allDownloadedPaths, true).catch(() => {});
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
    await onBeforeCleanup?.(allDownloadedPaths, uploadFailed).catch(() => {});
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
  const text = ctx.message.text;
  if (!text) {
    await next();
    return;
  }

  const query = isHttpURL(text) ? text : extractHttpURL(text);

  if (!query) {
    if (shouldFallbackToMusicSearch(text)) {
      await musicSearchFromMessage(ctx, text.trim());
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

  const operation = ctx.from ? createTrackedOperation(ctx.from.id) : null;
  const msg1 = await ctx.reply(`downloading...`, {
    reply_markup: operation ? getCancelKeyboard(operation.id) : undefined,
  });
  if (operation) {
    attachOperationMessage(operation.id, {
      chatId: msg1.chat.id,
      messageId: msg1.message_id,
    });
  }
  const userSettings = ctx.from
    ? getUserSettings(ctx.from.id)
    : getDefaultUserSettings();
  const downloadStrategy = userSettings.verboseOutput ? "all" : "single";
  const progressUpdater = operation
    ? createProgressUpdater(ctx, msg1, operation.id)
    : undefined;

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
        signal: operation?.controller.signal,
      },
    );
    if (operation) {
      completeTrackedOperation(operation.id);
    }

    if (res.contentType === "video") {
      const uploadedFile = res.variants.find(
        (file): file is Extract<VideoVariant, { downloaded: true }> =>
          file.downloaded && file.size <= maxFileSize,
      );
      const links = res.variants.map((file) =>
        generateVideoLinksEntry(file, uploadedFile),
      );
      const videoShareUrls: string[] = [];
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
        onBeforeCleanup: userSettings.fileShareMode === "never" ? undefined : async (paths, uploadFailed) => {
          if (userSettings.fileShareMode === "as-fallback" && !uploadFailed) return;
          const userId = ctx.from?.id ?? null;
          for (const p of paths) {
            const url = await shareFile(p, userId);
            if (url) videoShareUrls.push(url);
          }
        },
        sendMedia: (variant) =>
          ctx.replyWithVideo(new InputFile(variant.path), {
            width: variant.payload.resolution.width,
            height: variant.payload.resolution.height,
            duration: variant.payload.durationSeconds,
            supports_streaming: true,
          }),
      });
      logger.info(`sent video ${query} to ${ctx.from?.id ?? "unknown user"}`);
      await sendShareUrls(ctx, videoShareUrls);
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
      // one best downloaded variant per image, labelled by 1-based position
      const imageShareFiles: Array<{ label: number; path: string }> = [];
      for (let i = 0; i < res.variants.length; i++) {
        for (const v of res.variants[i]!) {
          if (v.downloaded) {
            imageShareFiles.push({ label: i + 1, path: v.path });
            break;
          }
        }
      }
      const imageShareResults: Array<{ label: number; url: string }> = [];
      let imageZipUrl: string | null = null;
      let uploadFailed = false;
      try {
        for (const chunk of chunkArray(media, MAX_MEDIA_GROUP_SIZE)) {
          await ctx.replyWithMediaGroup(chunk);
        }
      } catch (err) {
        uploadFailed = true;
        logError(err);
      } finally {
        const fsMode = userSettings.fileShareMode;
        if (fsMode !== "never" && (fsMode === "always" || uploadFailed)) {
          const userId = ctx.from?.id ?? null;
          for (const { label, path } of imageShareFiles) {
            const url = await shareFile(path, userId);
            if (url) imageShareResults.push({ label, url });
          }
          imageZipUrl = await createAndShareZip(imageShareFiles.map((f) => f.path), userId);
        }
        cleanup();
        deleteMessageSafe(ctx, msg1);
        deleteMessageSafe(ctx, msg2);
      }

      if (uploadFailed) {
        await ctx.reply(
          `images were downloaded, but Telegram rejected the upload. sending links instead.`,
        );
        await sendChunkedLinks(ctx, imageLinks);
        await sendGalleryShareUrls(ctx, imageShareResults, imageZipUrl);
        await next();
        return;
      }

      if (userSettings.verboseOutput) {
        await sendChunkedLinks(ctx, imageLinks);
      }
      await sendGalleryShareUrls(ctx, imageShareResults, imageZipUrl);
    } else if (res.contentType === "music") {
      const uploadedFile = res.variants.find(
        (file): file is Extract<MusicVariant, { downloaded: true }> =>
          file.downloaded && file.size <= maxFileSize,
      );
      const links = res.variants.map((file) =>
        generateMusicLinksEntry(file, uploadedFile),
      );
      const musicShareUrls: string[] = [];
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
        onBeforeCleanup: userSettings.fileShareMode === "never" ? undefined : async (paths, uploadFailed) => {
          if (userSettings.fileShareMode === "as-fallback" && !uploadFailed) return;
          const userId = ctx.from?.id ?? null;
          for (const p of paths) {
            const url = await shareFile(p, userId);
            if (url) musicShareUrls.push(url);
          }
        },
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
      await sendShareUrls(ctx, musicShareUrls);
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
      // one downloaded file per entry, labelled by 1-based entry position
      const galleryShareFiles: Array<{ label: number; path: string }> = [];
      for (let i = 0; i < res.entries.length; i++) {
        const entry = res.entries[i]!;
        for (const v of entry.variants) {
          if (v.downloaded) {
            galleryShareFiles.push({ label: i + 1, path: v.path });
            break;
          }
        }
      }

      if (!uploadableMedia.length) {
        const galleryShareResults: Array<{ label: number; url: string }> = [];
        let galleryZipUrl: string | null = null;
        if (userSettings.fileShareMode !== "never") {
          const userId = ctx.from?.id ?? null;
          for (const { label, path } of galleryShareFiles) {
            const url = await shareFile(path, userId);
            if (url) galleryShareResults.push({ label, url });
          }
          galleryZipUrl = await createAndShareZip(galleryShareFiles.map((f) => f.path), userId);
        }
        cleanup();
        deleteMessageSafe(ctx, msg1);
        deleteMessageSafe(ctx, msg2);
        await ctx.reply(
          `pinterest items were resolved, but nothing uploadable was produced. sending links instead.`,
        );
        await sendChunkedLinks(ctx, galleryLinks);
        await sendGalleryShareUrls(ctx, galleryShareResults, galleryZipUrl);
        await next();
        return;
      }

      const galleryShareResults: Array<{ label: number; url: string }> = [];
      let galleryZipUrl: string | null = null;
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
        const fsMode = userSettings.fileShareMode;
        if (fsMode !== "never" && (fsMode === "always" || uploadFailed)) {
          const userId = ctx.from?.id ?? null;
          for (const { label, path } of galleryShareFiles) {
            const url = await shareFile(path, userId);
            if (url) galleryShareResults.push({ label, url });
          }
          galleryZipUrl = await createAndShareZip(galleryShareFiles.map((f) => f.path), userId);
        }
        cleanup();
        deleteMessageSafe(ctx, msg1);
        deleteMessageSafe(ctx, msg2);
      }

      if (uploadFailed) {
        await ctx.reply(
          `pinterest items were downloaded, but Telegram rejected the upload. sending links instead.`,
        );
        await sendChunkedLinks(ctx, galleryLinks);
        await sendGalleryShareUrls(ctx, galleryShareResults, galleryZipUrl);
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
      await sendGalleryShareUrls(ctx, galleryShareResults, galleryZipUrl);
    }

    await next();
  } catch (err) {
    if (operation) {
      completeTrackedOperation(operation.id);
    }
    if (isCancelledError(err)) {
      logger.info(
        `cancelled download ${query} for ${ctx.from?.id ?? "unknown user"}`,
      );
    } else {
      logError(err);
      const errMsg = getUserFacingDownloadErrorMessage(err);
      ctx.api.deleteMessage(msg1.chat.id, msg1.message_id).catch();
      ctx.reply(`failed to download: ${errMsg}`);
    }
    await next();
  } finally {
    if (ctx.from) {
      finishUserJob(ctx.from.id);
    }
  }
};
