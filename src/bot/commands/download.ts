import {
  InputFile,
  type Context,
  type Filter,
  type MiddlewareFn,
} from "grammy";
import { downloadTiktok, type Video } from "src/dl/downloader";
import { logError, logger } from "src/utils/logger";
import { fileSizeToHumanReadable, isHttpURL } from "src/utils/utils";

const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

function generateLinksEntry(files: Video[], file: Video, best: Video): string {
  if (file.downloaded) {
    return (
      `<a href="${file.downloadUrl}">${file.resolution.width}x${file.resolution.height}</a> - ${fileSizeToHumanReadable(file.size)}` +
      (best.downloaded && file.path === best.path
        ? " ← <i>this version</i>"
        : "")
    );
  }
  const resString = "?x?";

  return `<a href="${file.downloadUrl}">${resString}</a> - ${fileSizeToHumanReadable(file.size)}`;
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

  logger.debug(`downloading video from ${query}...`);
  const msg1 = await ctx.reply(`downloading...`);

  try {
    const res = await downloadTiktok(query);
    if (!res) {
      logger.error(`failed to download video from ${query} (no result)`);
      await ctx.reply("failed to download");
      await next();
      return;
    }

    console.log("download ok", res);

    const validFiles = res.files
      .filter((file) => file.downloaded)
      .filter((file) => file.size <= MAX_FILE_SIZE); // telegram forbids uploading files >= 50mb
    const links = res.files.map((file) =>
      generateLinksEntry(res.files, file, validFiles[0]!),
    );

    console.log("valid files", validFiles);
    console.log("links", links);

    if (!validFiles.length) {
      logger.error(`no valid files found for ${query} (max size exceeded)`);
      await ctx.reply(
        `video was downloaded, but it exceeds ${MAX_FILE_SIZE_MB}mb and Telegram doesn't allow sending such big files. you can use these links yourself:\n` +
          links.join("\n"),
        { parse_mode: "HTML" },
      );
      try {
        res.cleanup();
      } catch {}
      await next();
      return;
    }

    console.log("replying...");
    const msg2 = await ctx.reply(
      `video downloaded, sending... (${validFiles.length} version${validFiles.length > 1 ? "s" : ""})`,
    );
    await ctx.api.sendChatAction(msg1.chat.id, "upload_video");
    await ctx
      .replyWithVideo(new InputFile(validFiles[0]!.path), {
        caption:
          `main link (best quality):\n${links[0]}` +
          (links.length > 1
            ? `\n\nother links:\n${links.slice(1).join("\n")}\n`
            : ""),
        parse_mode: "HTML",
      })
      .finally(() => {
        try {
          res.cleanup();
        } catch {}
        ctx.api.deleteMessage(msg1.chat.id, msg1.message_id).catch();
        ctx.api.deleteMessage(msg2.chat.id, msg2.message_id).catch();
      });

    logger.info(`sent video ${query} to ${ctx.from.id}`);

    await next();
  } catch (err) {
    logError(err);
    await ctx.reply("failed to download (internal error)");
    await next();
  }
};
