import {
  InputFile,
  InputMediaBuilder,
  type Context,
  type Filter,
  type MiddlewareFn,
} from "grammy";
import {
  downloadTiktok,
  type MusicVariant,
  type PhotoVariant,
  type VideoVariant,
} from "src/dl/downloader";
import { DownloadError } from "src/errors/download-error";
import {
  getDefaultUserSettings,
  getUserSettings,
} from "src/settings/user-settings";
import { chunkArray } from "src/utils/array";
import { logError, logger } from "src/utils/logger";
import { fileSizeToHumanReadable, isHttpURL } from "src/utils/utils";

const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_MEDIA_GROUP_SIZE = 10;
const MAX_MSG_LENGTH = 4000;

function splitLinkBlock(block: string): string[] {
  if (block.length <= MAX_MSG_LENGTH) {
    return [block];
  }

  const chunks: string[] = [];
  let currentChunk = "";

  for (const line of block.split("\n")) {
    if (line.length > MAX_MSG_LENGTH) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = "";
      }

      for (let i = 0; i < line.length; i += MAX_MSG_LENGTH) {
        chunks.push(line.slice(i, i + MAX_MSG_LENGTH));
      }
      continue;
    }

    if (!currentChunk) {
      currentChunk = line;
      continue;
    }

    if (currentChunk.length + line.length + 1 > MAX_MSG_LENGTH) {
      chunks.push(currentChunk);
      currentChunk = line;
      continue;
    }

    currentChunk = `${currentChunk}\n${line}`;
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

async function sendChunkedLinks(
  ctx: Filter<Context, "message">,
  linkBlocks: string[],
): Promise<void> {
  const normalizedBlocks = linkBlocks.flatMap(splitLinkBlock);
  let currentMsg = "";

  for (const linkBlock of normalizedBlocks) {
    if (currentMsg.length + linkBlock.length + 2 > MAX_MSG_LENGTH) {
      if (currentMsg) {
        await ctx.reply(currentMsg, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      }
      currentMsg = linkBlock;
      continue;
    }

    currentMsg = currentMsg ? `${currentMsg}\n\n${linkBlock}` : linkBlock;
  }

  if (currentMsg) {
    await ctx.reply(currentMsg, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }
}

function generateVideoLinksEntry(
  variant: VideoVariant,
  best?: VideoVariant,
): string {
  if (variant.downloaded) {
    return (
      `<a href="${variant.downloadUrl}">${variant.payload.resolution.width}x${variant.payload.resolution.height}</a> - ${fileSizeToHumanReadable(variant.size)}` +
      (best?.downloaded && variant.path === best.path
        ? " ← <i>this version</i>"
        : "")
    );
  }
  return `<a href="${variant.downloadUrl}">?x?</a> - ? MB <i>(download failed)</i>`;
}

function generatePhotosLinksEntry(
  imgVariants: PhotoVariant[],
  best?: PhotoVariant,
): string {
  return imgVariants
    .map((variant) => {
      if (variant.downloaded) {
        return (
          `<a href="${variant.downloadUrl}">${variant.payload.resolution.width}x${variant.payload.resolution.height}</a> - ${fileSizeToHumanReadable(variant.size)}` +
          (best?.downloaded &&
          variant.path === best.path &&
          imgVariants.length > 1
            ? " ← <i>this version</i>"
            : "")
        );
      }
      return `<a href="${variant.downloadUrl}">?x?</a>`;
    })
    .join("\n");
}

function generateMusicLinksEntry(
  variant: MusicVariant,
  best?: MusicVariant,
): string {
  if (variant.downloaded) {
    return (
      `<a href="${variant.downloadUrl}">${fileSizeToHumanReadable(variant.size)}</a>` +
      (best?.downloaded && variant.path === best.path
        ? " ← <i>this version</i>"
        : "")
    );
  }

  return `<a href="${variant.downloadUrl}">? MB</a>`;
}

function deleteMessageSafe(
  ctx: Filter<Context, "message">,
  message?: { chat: { id: number }; message_id: number },
) {
  if (!message) return;
  ctx.api.deleteMessage(message.chat.id, message.message_id).catch();
}

function buildSingleMediaLinksMessage(links: string[]): string {
  return (
    `selected link:\n${links[0]}` +
    (links.length > 1
      ? `\n\nother attempted links:\n${links.slice(1).join("\n")}`
      : "")
  );
}

async function sendSingleMediaResult<T extends VideoVariant | MusicVariant>({
  ctx,
  loadingMessage,
  progressText,
  fallbackText,
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
  try {
    await ctx.api.sendChatAction(loadingMessage.chat.id, uploadAction);
    await sendMedia(validFiles[0]!);
  } finally {
    cleanup();
    deleteMessageSafe(ctx, loadingMessage);
    deleteMessageSafe(ctx, progressMessage);
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
    const { res, cleanup } = await downloadTiktok(
      query,
      userSettings.downloadSources,
      {
        strategy: downloadStrategy,
        maxFileSize: MAX_FILE_SIZE,
      },
    );
    if (!res) {
      logger.error(`failed to download tiktok from ${query} (no result)`);
      await ctx.reply("failed to download");
      await next();
      return;
    }

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

      const media = res.variants
        .filter((v) => v.length)
        .map((v) => {
          const downloaded = v.filter((vv) => vv.downloaded);
          return InputMediaBuilder.photo(
            new InputFile(
              downloaded.length ? downloaded[0]!.path : v[0]!.downloadUrl,
            ),
          );
        });
      try {
        for (const chunk of chunkArray(media, MAX_MEDIA_GROUP_SIZE)) {
          await ctx.replyWithMediaGroup(chunk);
        }
      } finally {
        cleanup();
        deleteMessageSafe(ctx, msg1);
        deleteMessageSafe(ctx, msg2);
      }

      if (userSettings.verboseOutput) {
        await sendChunkedLinks(
          ctx,
          res.variants.map(
            (img, i) =>
              `image ${i + 1}:\n` +
              generatePhotosLinksEntry(
                img,
                img.find((variant) => variant.downloaded),
              ),
          ),
        );
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
