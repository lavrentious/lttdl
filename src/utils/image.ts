import sharp from "sharp";
import { withTimeout } from "./async";

const IMAGE_PROCESS_TIMEOUT_MS = 15000;

export async function getImageResolution(path: string) {
  const img = sharp(path);
  const meta = await withTimeout(
    img.metadata(),
    IMAGE_PROCESS_TIMEOUT_MS,
    "image metadata read",
  );
  return { width: +meta.width, height: +meta.height };
}

export async function recodeImageToJpeg(path: string, newPath: string) {
  await withTimeout(
    sharp(path).jpeg().toFile(newPath),
    IMAGE_PROCESS_TIMEOUT_MS,
    "image recode",
  );
}
