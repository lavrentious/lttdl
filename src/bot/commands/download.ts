import {
  InputFile,
  InputMediaBuilder,
  type Context,
  type Filter,
  type MiddlewareFn,
} from "grammy";
import {
  DownloadSource,
  downloadTiktok,
  type MusicVariant,
  type PhotoVariant,
  type VideoVariant,
} from "src/dl/downloader";
import { DownloadError } from "src/errors/download-error";
import { chunkArray } from "src/utils/array";
import { logError, logger } from "src/utils/logger";
import { fileSizeToHumanReadable, isHttpURL } from "src/utils/utils";

const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_MEDIA_GROUP_SIZE = 10;
const MAX_MSG_LENGTH = 4000;

async function sendChunkedLinks(
  ctx: Filter<Context, "message">,
  linkBlocks: string[],
): Promise<void> {
  let currentMsg = "";

  for (const linkBlock of linkBlocks) {
    if (currentMsg.length + linkBlock.length + 2 > MAX_MSG_LENGTH) {
      await ctx.reply(currentMsg, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
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
  return `<a href="${variant.downloadUrl}">?x?</a>`;
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

  try {
    const { res, cleanup } = await downloadTiktok(query, [
      DownloadSource.V1,
      DownloadSource.V2,
      // DownloadSource.V3,
    ]);
    if (!res) {
      logger.error(`failed to download tiktok from ${query} (no result)`);
      await ctx.reply("failed to download");
      await next();
      return;
    }

    if (res.contentType === "video") {
      const validFiles = res.variants
        .filter((file) => file.downloaded)
        .filter((file) => file.size <= MAX_FILE_SIZE); // telegram forbids uploading files >= 50mb
      const links = res.variants.map((file) =>
        generateVideoLinksEntry(file, validFiles[0]),
      );

      if (res.variants.length && !validFiles.length) {
        logger.warn(`no valid files found for ${query} (max size exceeded)`);
        await ctx.reply(
          `video was downloaded, but it exceeds ${MAX_FILE_SIZE_MB}mb and Telegram doesn't allow sending such big files.`,
        );
        await sendChunkedLinks(ctx, links);
        try {
          cleanup();
        } catch {}
        await next();
        return;
      }

      const msg2 = await ctx.reply(
        `video downloaded, sending... (${validFiles.length} version${validFiles.length > 1 ? "s" : ""})`,
      );
      await ctx.api.sendChatAction(msg1.chat.id, "upload_video");
      await ctx
        .replyWithVideo(new InputFile(validFiles[0]!.path))
        .finally(() => {
          try {
            cleanup();
          } catch {}
          ctx.api.deleteMessage(msg1.chat.id, msg1.message_id).catch();
          ctx.api.deleteMessage(msg2.chat.id, msg2.message_id).catch();
        });
      await sendChunkedLinks(ctx, [
        `main link (best quality):\n${links[0]}` +
          (links.length > 1
            ? `\n\nother links:\n${links.slice(1).join("\n")}`
            : ""),
      ]);

      logger.info(`sent video ${query} to ${ctx.from.id}`);
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
      for (const chunk of chunkArray(media, MAX_MEDIA_GROUP_SIZE)) {
        await ctx.replyWithMediaGroup(chunk);
      }

      const links = res.variants.map(
        (img, i) =>
          `image ${i}:\n` +
          generatePhotosLinksEntry(img, img.filter((v) => v.downloaded)[0]),
      );

      cleanup();
      ctx.api.deleteMessage(msg1.chat.id, msg1.message_id).catch();
      ctx.api.deleteMessage(msg2.chat.id, msg2.message_id).catch();
      await sendChunkedLinks(ctx, links);
    } else if (res.contentType === "music") {
      const validFiles = res.variants
        .filter((file) => file.downloaded)
        .filter((file) => file.size <= MAX_FILE_SIZE); // telegram forbids uploading files >= 50mb
      const links = res.variants.map((file) =>
        generateMusicLinksEntry(file, validFiles[0]),
      );

      if (res.variants.length && !validFiles.length) {
        logger.warn(`no valid files found for ${query} (max size exceeded)`);
        await ctx.reply(
          `music was downloaded, but it exceeds ${MAX_FILE_SIZE_MB}mb and Telegram doesn't allow sending such big files.`,
        );
        await sendChunkedLinks(ctx, links);
        try {
          cleanup();
        } catch {}
        await next();
        return;
      }

      const msg2 = await ctx.reply(
        `music downloaded, sending... (${validFiles.length} version${validFiles.length > 1 ? "s" : ""})`,
      );
      await ctx.api.sendChatAction(msg1.chat.id, "upload_voice");
      await ctx
        .replyWithAudio(
          new InputFile(validFiles[0]!.path, validFiles[0]!.payload.name),
        )
        .finally(() => {
          try {
            cleanup();
          } catch {}
          ctx.api.deleteMessage(msg1.chat.id, msg1.message_id).catch();
          ctx.api.deleteMessage(msg2.chat.id, msg2.message_id).catch();
        });
      await sendChunkedLinks(ctx, [
        `main link (best quality):\n${links[0]}` +
          (links.length > 1
            ? `\n\nother links:\n${links.slice(1).join("\n")}`
            : ""),
      ]);

      logger.info(`sent audio ${query} to ${ctx.from.id}`);
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
