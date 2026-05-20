import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "fs";
import { InputFile, type Context, type Filter, type MiddlewareFn } from "grammy";
import path from "path";
import { withTimeout } from "src/utils/async";
import { config } from "src/utils/env-validation";
import { applyMemeText } from "src/utils/image";
import { logError, logger } from "src/utils/logger";

// "." in a line position means "no text at this position".
// Valid patterns:
//   "top"         → topText="top", bottomText=null
//   ".\nbottom"   → topText=null, bottomText="bottom"
//   "top\nbottom" → topText="top", bottomText="bottom"
function parseMemeCaption(
  caption: string | undefined,
): { topText: string | null; bottomText: string | null } | null {
  if (!caption) return null;
  const lines = caption
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0 || lines.length > 2) return null;
  const toText = (line: string | undefined): string | null =>
    line === undefined || line === "." ? null : line;
  const topText = toText(lines[0]);
  const bottomText = toText(lines[1]);
  if (topText === null && bottomText === null) return null;
  return { topText, bottomText };
}

export const memeCommand: MiddlewareFn<Filter<Context, "message:photo">> = async (ctx, next) => {
  const parsed = parseMemeCaption(ctx.message.caption);
  if (!parsed) {
    await next();
    return;
  }

  const tempDir = config.get("TEMP_DIR");
  mkdirSync(tempDir, { recursive: true });

  const downloadedPath = path.join(tempDir, randomUUIDv7());
  const outputPath = path.join(tempDir, `${randomUUIDv7()}.jpg`);

  try {
    const photo = ctx.message.photo.at(-1)!;
    const fileInfo = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.get("BOT_TOKEN")}/${fileInfo.file_path}`;

    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`photo download failed: ${res.status}`);
    await Bun.write(downloadedPath, res);

    await withTimeout(
      applyMemeText(downloadedPath, outputPath, parsed.topText, parsed.bottomText),
      config.get("IMAGE_PROCESS_TIMEOUT_MS"),
      "meme generation",
    );

    await ctx.replyWithPhoto(new InputFile(outputPath));
  } catch (err) {
    logError(err);
    logger.warn(`meme generation failed for user ${ctx.from?.id ?? "unknown"}`);
    await next();
  } finally {
    for (const p of [downloadedPath, outputPath]) {
      try {
        rmSync(p);
      } catch {}
    }
  }
};
