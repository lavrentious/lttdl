import type { Context } from "grammy";

export function isHttpURL(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function fileSizeToHumanReadable(size: number) {
  const i = Math.floor(Math.log(size) / Math.log(1024));
  return (
    (size / Math.pow(1024, i)).toFixed(2) +
    " " +
    ["B", "kB", "MB", "GB", "TB"][i]
  );
}

export function escapeMarkdownV2(text: string): string {
  const escapeChars = /[_*[\]()~`>#+\-=|{}.!]/g;
  return text.replace(escapeChars, (match) => "\\" + match);
}

async function sendChunkedLinks(
  ctx: Context,
  prefix: string,
  links: string[],
  limit: number = 4000,
) {
  let currentMsg = prefix ? `${prefix}\n\n` : "";

  for (const linkBlock of links) {
    if (currentMsg.length + linkBlock.length + 2 > limit) {
      if (currentMsg.trim()) {
        await ctx.reply(currentMsg, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      }
      currentMsg = linkBlock;
    } else {
      currentMsg = currentMsg ? `${currentMsg}\n\n${linkBlock}` : linkBlock;
    }
  }

  if (currentMsg.trim()) {
    await ctx.reply(currentMsg, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }
}
