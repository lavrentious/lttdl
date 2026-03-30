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

export async function createCenteredSquareJpeg(
  input: ArrayBuffer | Uint8Array,
  outputPath: string,
  size = 640,
) {
  const buffer = input instanceof Uint8Array ? Buffer.from(input) : Buffer.from(new Uint8Array(input));

  await withTimeout(
    sharp(buffer)
      .resize(size, size, {
        fit: "cover",
        position: "centre",
      })
      .jpeg()
      .toFile(outputPath),
    IMAGE_PROCESS_TIMEOUT_MS,
    "image crop",
  );
}
