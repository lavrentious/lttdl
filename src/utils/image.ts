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
