import sharp from "sharp";

export async function getImageResolution(path: string) {
  const img = sharp(path);
  const meta = await img.metadata();
  return { width: +meta.width, height: +meta.height };
}

export async function recodeImageToJpeg(path: string, newPath: string) {
  await sharp(path).jpeg().toFile(newPath);
}
