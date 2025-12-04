import { Downloader as fetchTiktok } from "@tobyg74/tiktok-api-dl";
import { $, randomUUIDv7 } from "bun";
import path from "path";
import { config } from "src/utils/env-validation";
import { logger } from "src/utils/logger";
import { getVideoSize } from "src/utils/video";

const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

export type Video = {
  size: number; // in bytes
  downloadUrl: string;
} & (
  | {
      downloaded: false;
    }
  | {
      downloaded: true;
      resolution: { width: number; height: number };
      path: string;
    }
);

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

  const res: Video[] = await Promise.all(
    urls.map(async (url) => {
      logger.debug(`downloading ${url}...`);
      // const size = await getVideoSize(url);
      // logger.debug(`size: ${size}`);
      // if (size > MAX_FILE_SIZE || !size) {
      //   logger.debug(`invalid size: skipping ${url}`);
      //   return { size, downloadUrl: url, downloaded: false };
      // }
      const path = await downloadFile(url);
      logger.debug(`downloaded to ${path}`);
      logger.debug(`getting video resolution for ${path}...`);
      const res = await getVideoResolution(path);
      logger.debug(`resolution: ${JSON.stringify(res)}`);

      return {
        resolution: res,
        downloaded: true,
        downloadUrl: url,
        path,
        size: Bun.file(path).size,
      };
    }),
  );

  return res;
}

export enum DownloadSource {
  V1 = "v1",
  V2 = "v2",
  V3 = "v3",
}
export async function downloadTiktok(
  url: string,
  tempDir?: string,
  downloadSources?: DownloadSource[],
): Promise<{ files: Video[]; cleanup: () => void } | null> {
  if (!tempDir) {
    tempDir = config.get("TEMP_DIR");
  }

  logger.debug(`downloading video from ${url}...`);
  const res = (
    await Promise.allSettled(
      [getDownloadUrlV2].map(async (fn) =>
        fn(url).then(processDownloadUrls),
      ),
    )
  )
    .filter((res) => res.status === "fulfilled")
    .map((res) => res.value)
    .flat();
  logger.debug(`res: ${JSON.stringify(res)}`);

  // select best resolution, delete other files
  const sorted = res.sort((a, b) =>
    a.downloaded && b.downloaded
      ? b.resolution.width * b.resolution.height -
        a.resolution.width * a.resolution.height
      : b.size - a.size,
  );
  if (!sorted.length) return null;
  return {
    files: sorted,
    cleanup: () =>
      sorted
        .filter((v) => v.downloaded)
        .forEach(({ path }) => {
          Bun.file(path).delete();
        }),
  };
}
