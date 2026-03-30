import type { Context, Filter } from "grammy";
import type {
  GalleryEntry,
  MusicVariant,
  PhotoVariant,
  VideoVariant,
} from "src/dl/downloader";
import { fileSizeToHumanReadable } from "src/utils/utils";

export const MAX_LINK_MESSAGE_LENGTH = 4000;

export function splitLinkBlock(
  block: string,
  maxLength = MAX_LINK_MESSAGE_LENGTH,
): string[] {
  if (block.length <= maxLength) {
    return [block];
  }

  const chunks: string[] = [];
  let currentChunk = "";

  for (const line of block.split("\n")) {
    if (line.length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = "";
      }

      for (let i = 0; i < line.length; i += maxLength) {
        chunks.push(line.slice(i, i + maxLength));
      }
      continue;
    }

    if (!currentChunk) {
      currentChunk = line;
      continue;
    }

    if (currentChunk.length + line.length + 1 > maxLength) {
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

export async function sendChunkedLinks(
  ctx: Context,
  linkBlocks: string[],
): Promise<void> {
  const normalizedBlocks = linkBlocks.flatMap((block) => splitLinkBlock(block));
  let currentMsg = "";

  for (const linkBlock of normalizedBlocks) {
    if (currentMsg.length + linkBlock.length + 2 > MAX_LINK_MESSAGE_LENGTH) {
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

export function generateVideoLinksEntry(
  variant: VideoVariant,
  best?: VideoVariant,
): string {
  if (variant.downloaded) {
    return (
      `<a href="${variant.downloadUrl}">${variant.payload.resolution.width}x${variant.payload.resolution.height}</a> - ${fileSizeToHumanReadable(variant.size)}` +
      (variant.payload.details ? ` - <i>${variant.payload.details}</i>` : "") +
      (best?.downloaded && variant.path === best.path
        ? " ← <i>this version</i>"
        : "")
    );
  }
  return `<a href="${variant.downloadUrl}">?x?</a>`;
}

export function generatePhotosLinksEntry(
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

export function generateMusicLinksEntry(
  variant: MusicVariant,
  best?: MusicVariant,
): string {
  if (variant.downloaded) {
    return (
      `<a href="${variant.downloadUrl}">${fileSizeToHumanReadable(variant.size)}</a>` +
      (variant.payload.details ? ` - <i>${variant.payload.details}</i>` : "") +
      (best?.downloaded && variant.path === best.path
        ? " ← <i>this version</i>"
        : "")
    );
  }

  return `<a href="${variant.downloadUrl}">? MB</a>`;
}

export function buildSingleMediaLinksMessage(links: string[]): string {
  return (
    `selected link:\n${links[0]}` +
    (links.length > 1
      ? `\n\nother attempted links:\n${links.slice(1).join("\n")}`
      : "")
  );
}

export function buildImageLinksMessages(images: PhotoVariant[][]): string[] {
  return images.map(
    (img, i) =>
      `image ${i + 1}:\n` +
      generatePhotosLinksEntry(
        img,
        img.find((variant) => variant.downloaded),
      ),
  );
}

export function buildGalleryLinksMessages(entries: GalleryEntry[]): string[] {
  return entries.map((entry, i) => {
    if (entry.kind === "image") {
      return (
        `item ${i + 1} (image):\n` +
        generatePhotosLinksEntry(
          entry.variants,
          entry.variants.find((variant) => variant.downloaded),
        )
      );
    }

    return (
      `item ${i + 1} (video):\n` +
      entry.variants
        .map((variant) =>
          generateVideoLinksEntry(
            variant,
            entry.variants.find((candidate) => candidate.downloaded),
          ),
        )
        .join("\n")
    );
  });
}
