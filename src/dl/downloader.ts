import { Downloader as fetchTiktok } from "@tobyg74/tiktok-api-dl";
import { $, randomUUIDv7 } from "bun";
import path from "path";
import { config } from "src/utils/env-validation";
import { logger } from "src/utils/logger";

type Video = {
  width: number;
  height: number;
  path: string;
  size: number; // in bytes
  downloadUrl: string;
};

async function downloadFile(url: string, dir?: string, name?: string) {
  if (!dir) dir = config.get("TEMP_DIR");
  if (!name) name = randomUUIDv7() + ".mp4";
  const outputPath = path.join(dir, name);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download: ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  await Bun.write(outputPath, arrayBuffer, { createPath: true });
  return outputPath;
}

async function getDownloadUrlV1(url: string) {
  logger.debug("trying v1...");
  const res = await fetchTiktok(url, {
    version: "v1",
  });
  return res.result?.video?.playAddr ?? null;
}

async function getDownloadUrlV2(url: string) {
  logger.debug("trying v2...");
  const res = await fetchTiktok(url, {
    version: "v2",
  });
  return res.result?.video?.playAddr ?? null;
}

async function getDownloadUrlV3(url: string) {
  logger.debug("trying v3...");
  const res = await fetchTiktok(url, {
    version: "v3",
  });
  const downloadUrl = res.result?.videoHD || res.result?.videoSD;
  return downloadUrl ? [downloadUrl] : null;
}

async function getVideoResolution(path: string) {
  const output =
    await $`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json ${path}`.text();
  const info = JSON.parse(output);
  const stream = info.streams?.[0];
  return { width: +stream.width, height: +stream.height };
}

async function processDownloadUrls(urls: string[] | null): Promise<Video[]> {
  if (!urls) {
    return [];
  }
  const res = await Promise.all(
    urls.map((url) =>
      downloadFile(url).then(async (path) => {
        const res = await getVideoResolution(path);
        return { ...res, downloadUrl: url, path, size: Bun.file(path).size };
      }),
    ),
  );

  return res;
}

export async function downloadTiktok(
  url: string,
  tempDir?: string,
): Promise<{ files: Video[]; cleanup: () => void } | null> {
  if (!tempDir) {
    tempDir = config.get("TEMP_DIR");
  }

  const res = (
    await Promise.allSettled([
      getDownloadUrlV1(url).then(processDownloadUrls),
      getDownloadUrlV2(url).then(processDownloadUrls),
      getDownloadUrlV3(url).then(processDownloadUrls),
    ])
  )
    .filter((res) => res.status === "fulfilled")
    .map((res) => res.value)
    .flat();

  // select best resolution, delete other files
  const sorted = res.sort((a, b) => b.width * b.height - a.width * a.height);
  if (!sorted.length) return null;
  return {
    files: sorted,
    cleanup: () =>
      sorted.forEach(({ path }) => {
        Bun.file(path).delete();
      }),
  };
}
