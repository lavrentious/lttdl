import {
  InputFile,
  InputMediaBuilder,
  type Context,
  type Filter,
  type MiddlewareFn,
} from "grammy";
import {
  downloadContent,
  type MusicVariant,
  type VideoVariant,
} from "src/dl/downloader";
import {
  buildImageLinksMessages,
  buildSingleMediaLinksMessage,
  generateMusicLinksEntry,
  generateVideoLinksEntry,
  sendChunkedLinks,
} from "./download-presentation";
import { DownloadError } from "src/errors/download-error";
import {
  getDefaultUserSettings,
  getUserSettings,
} from "src/settings/user-settings";
import { chunkArray } from "src/utils/array";
import { logError, logger } from "src/utils/logger";
import { isHttpURL } from "src/utils/utils";

const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_MEDIA_GROUP_SIZE = 10;

function deleteMessageSafe(
  ctx: Filter<Context, "message">,
  message?: { chat: { id: number }; message_id: number },
) {
  if (!message) return;
  ctx.api.deleteMessage(message.chat.id, message.message_id).catch();
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
  const validFiles = variants
    .filter((file): file is Extract<T, { downloaded: true }> => file.downloaded)
    .filter((file) => file.size <= MAX_FILE_SIZE);

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
  const query = ctx.message.text;
  if (!query || !isHttpURL(query)) {
    await next();
    return;
  }

  const msg1 = await ctx.reply(`downloading...`);
  const userSettings = ctx.from
    ? getUserSettings(ctx.from.id)
    : getDefaultUserSettings();
  const downloadStrategy = userSettings.verboseOutput ? "all" : "single";

  try {
    const { res, cleanup } = await downloadContent(
      query,
      {
        tiktokProviders: userSettings.platformPreferences.tiktok.providers,
        youtubePreset: userSettings.platformPreferences.youtube.preset,
      },
      {
        strategy: downloadStrategy,
        maxFileSize: MAX_FILE_SIZE,
      },
    );

    if (res.contentType === "video") {
      const uploadedFile = res.variants.find(
        (file): file is Extract<VideoVariant, { downloaded: true }> =>
          file.downloaded && file.size <= MAX_FILE_SIZE,
      );
      const links = res.variants.map((file) =>
        generateVideoLinksEntry(file, uploadedFile),
      );
      await sendSingleMediaResult({
        ctx,
        loadingMessage: msg1,
        progressText: `video downloaded, sending...`,
        fallbackText: `video was downloaded, but it exceeds ${MAX_FILE_SIZE_MB}mb and Telegram doesn't allow sending such big files.`,
        uploadFailureText: `video was downloaded, but Telegram rejected the upload. sending links instead.`,
        uploadAction: "upload_video",
        variants: res.variants,
        links,
        verboseOutput: userSettings.verboseOutput,
        cleanup,
        sendMedia: (variant) => ctx.replyWithVideo(new InputFile(variant.path)),
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
              downloaded.length ? downloaded[0]!.path : variants[0]!.downloadUrl,
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
          file.downloaded && file.size <= MAX_FILE_SIZE,
      );
      const links = res.variants.map((file) =>
        generateMusicLinksEntry(file, uploadedFile),
      );
      await sendSingleMediaResult({
        ctx,
        loadingMessage: msg1,
        progressText: `music downloaded, sending...`,
        fallbackText: `music was downloaded, but it exceeds ${MAX_FILE_SIZE_MB}mb and Telegram doesn't allow sending such big files.`,
        uploadFailureText: `music was downloaded, but Telegram rejected the upload. sending links instead.`,
        uploadAction: "upload_voice",
        variants: res.variants,
        links,
        verboseOutput: userSettings.verboseOutput,
        cleanup,
        sendMedia: (variant) =>
          ctx.replyWithAudio(new InputFile(variant.path, variant.payload.name)),
      });

      logger.info(`sent audio ${query} to ${ctx.from?.id ?? "unknown user"}`);
    }

    await next();
  } catch (err) {
    logError(err);
    const errMsg =
      err instanceof DownloadError ? err.message : "internal error";
    ctx.api.deleteMessage(msg1.chat.id, msg1.message_id).catch();
    ctx.reply(`failed to download: ${errMsg}`);
    await next();
  }
};
