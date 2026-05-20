import { readFileSync } from "fs";
import path from "path";
import sharp from "sharp";
import { config } from "./env-validation";
import { withTimeout } from "./async";

export async function getImageResolution(path: string) {
  const imageProcessTimeoutMs = config.get("IMAGE_PROCESS_TIMEOUT_MS");
  const img = sharp(path);
  const meta = await withTimeout(
    img.metadata(),
    imageProcessTimeoutMs,
    "image metadata read",
  );
  return { width: +meta.width, height: +meta.height };
}

export async function recodeImageToJpeg(path: string, newPath: string) {
  const imageProcessTimeoutMs = config.get("IMAGE_PROCESS_TIMEOUT_MS");
  await withTimeout(
    sharp(path).jpeg().toFile(newPath),
    imageProcessTimeoutMs,
    "image recode",
  );
}

let _fontBase64: string | null = null;

function _getFontBase64(): string {
  if (!_fontBase64) {
    const fontPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "../assets/fonts/Anton-Regular.ttf",
    );
    _fontBase64 = readFileSync(fontPath).toString("base64");
  }
  return _fontBase64;
}

function _calcMemeFont(imageWidth: number): number {
  return Math.min(120, Math.max(24, Math.floor(imageWidth * 0.09)));
}

function _wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const maxChars = Math.floor(maxWidth / (fontSize * 0.55));
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function _escapeSvg(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _buildTextElement(
  lines: string[],
  cx: number,
  blockStartY: number,
  fontSize: number,
  strokeWidth: number,
  dominantBaseline: string,
): string {
  const attrs = `font-family="Impact, sans-serif" font-size="${fontSize}" font-weight="bold" fill="white" stroke="black" stroke-width="${strokeWidth}" stroke-linejoin="round" paint-order="stroke fill" text-anchor="middle"`;
  const tspans = lines
    .map(
      (line, i) =>
        `<tspan x="${cx}"${i === 0 ? "" : ` dy="${fontSize * 1.2}"`}>${_escapeSvg(line)}</tspan>`,
    )
    .join("");
  return `<text x="${cx}" y="${blockStartY}" ${attrs} dominant-baseline="${dominantBaseline}">${tspans}</text>`;
}

export async function applyMemeText(
  inputPath: string,
  outputPath: string,
  topText: string | null,
  bottomText: string | null,
): Promise<void> {
  const imageProcessTimeoutMs = config.get("IMAGE_PROCESS_TIMEOUT_MS");
  const meta = await withTimeout(
    sharp(inputPath).metadata(),
    imageProcessTimeoutMs,
    "meme image metadata",
  );
  const W = meta.width ?? 800;
  const H = meta.height ?? 600;

  const fontSize = _calcMemeFont(W);
  const strokeWidth = Math.max(2, Math.ceil(fontSize * 0.05));
  const maxTextWidth = W * 0.92;
  const edgePad = Math.floor(H * 0.04);
  const fontB64 = _getFontBase64();

  const parts: string[] = [];

  if (topText) {
    const lines = _wrapText(topText.toUpperCase(), fontSize, maxTextWidth);
    parts.push(_buildTextElement(lines, W / 2, edgePad, fontSize, strokeWidth, "hanging"));
  }

  if (bottomText) {
    const lines = _wrapText(bottomText.toUpperCase(), fontSize, maxTextWidth);
    const lineHeight = fontSize * 1.2;
    const blockStartY = H - edgePad - (lines.length - 1) * lineHeight;
    parts.push(_buildTextElement(lines, W / 2, blockStartY, fontSize, strokeWidth, "auto"));
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><style>@font-face{font-family:'Anton';src:url('data:font/truetype;base64,${fontB64}')}</style></defs>
  ${parts.join("\n  ")}
</svg>`;

  await withTimeout(
    sharp(inputPath)
      .composite([{ input: Buffer.from(svg), gravity: "northwest" }])
      .jpeg()
      .toFile(outputPath),
    imageProcessTimeoutMs,
    "meme text overlay",
  );
}

export async function createCenteredSquareJpeg(
  input: ArrayBuffer | Uint8Array,
  outputPath: string,
  size = 640,
) {
  const imageProcessTimeoutMs = config.get("IMAGE_PROCESS_TIMEOUT_MS");
  const buffer = input instanceof Uint8Array ? Buffer.from(input) : Buffer.from(new Uint8Array(input));

  await withTimeout(
    sharp(buffer)
      .resize(size, size, {
        fit: "cover",
        position: "centre",
      })
      .jpeg()
      .toFile(outputPath),
    imageProcessTimeoutMs,
    "image crop",
  );
}
