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
