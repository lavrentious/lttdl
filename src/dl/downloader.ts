import { randomUUIDv7 } from "bun";
import path from "path";
import { DownloadError } from "src/errors/download-error";
import { zipArrays } from "src/utils/array";
import { config } from "src/utils/env-validation";
import { getImageResolution, recodeImageToJpeg } from "src/utils/image";
import { logger } from "src/utils/logger";
import { getVideoResolution } from "src/utils/video";
import type { Fetcher } from "./fetcher/base-fetcher";
import { V1Fetcher } from "./fetcher/v1-fetcher";
import { V2Fetcher } from "./fetcher/v2-fetcher";
import { V3Fetcher } from "./fetcher/v3-fetcher";

const FETCH_INFO_TIMEOUT_MS = 15000;
const FILE_DOWNLOAD_TIMEOUT_MS = 45000;

type ContentVariant<T> = {
  downloadUrl: string;
  cleanup?: () => void;
} & (
  | {
      downloaded: false;
    }
  | {
      downloaded: true;
      path: string;
      size: number; // in bytes
      payload: T;
    }
);

export type VideoVariant = ContentVariant<{
  resolution: { width: number; height: number };
}>;

export type PhotoVariant = ContentVariant<{
  resolution: { width: number; height: number };
}>;

export type MusicVariant = ContentVariant<{
  name?: string;
}>;

async function downloadFile(url: string, dir?: string, name?: string) {
  if (!dir) dir = config.get("TEMP_DIR");
  if (!name) name = randomUUIDv7();
  const outputPath = path.join(dir, name);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Failed to download: ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  await Bun.write(outputPath, arrayBuffer, { createPath: true });
  return outputPath;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: Timer | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export enum DownloadSource {
  V1 = "v1",
  V2 = "v2",
  V3 = "v3",
}
export const ALL_DOWNLOAD_SOURCES = [
  DownloadSource.V1,
  DownloadSource.V2,
  DownloadSource.V3,
] as const;
const fetcherMap = {
  [DownloadSource.V1]: V1Fetcher,
  [DownloadSource.V2]: V2Fetcher,
  [DownloadSource.V3]: V3Fetcher,
} as Record<DownloadSource, new (url: string) => Fetcher>;
type DownloadResult =
  | {
      contentType: "video";
      variants: VideoVariant[];
    }
  | {
      contentType: "image";
      variants: PhotoVariant[][];
    }
  | {
      contentType: "music";
      variants: MusicVariant[];
    };
export type DownloadStrategy = "all" | "single";

type DownloadOptions = {
  tempDir?: string;
  strategy?: DownloadStrategy;
  maxFileSize?: number;
};

type DownloadContentType = DownloadResult["contentType"];

type ResolvedDownloadInfo = {
  contentType: DownloadContentType;
  contentName: string | null;
  urls: string[][];
};

function cleanupVariant(variant: { cleanup?: () => void }) {
  try {
    variant.cleanup?.();
  } catch {}
}

function sortByResolution<
  T extends VideoVariant | PhotoVariant,
>(variants: T[]): T[] {
  return [...variants].sort((a, b) =>
    a.downloaded && b.downloaded
      ? b.payload.resolution.width * b.payload.resolution.height -
        a.payload.resolution.width * a.payload.resolution.height
      : 0,
  );
}

async function downloadVideoVariant(
  url: string,
  tempDir: string,
): Promise<VideoVariant> {
  logger.debug(`downloading video from ${url}...`);
  let path: string | null = null;
  try {
    path = await downloadFile(url, tempDir);
    const downloadedPath = path;
    logger.debug(`downloaded video to ${path}`);
    logger.debug(`getting video resolution for ${path}...`);
    const resolution = await getVideoResolution(path);
    logger.debug(`resolution: ${JSON.stringify(resolution)}`);

    return {
      payload: { resolution },
      downloaded: true,
      downloadUrl: url,
      path: downloadedPath,
      size: Bun.file(downloadedPath).size,
      cleanup: () => {
        Bun.file(downloadedPath).delete().catch();
      },
    } satisfies VideoVariant;
  } catch {
    if (path) {
      Bun.file(path).delete().catch();
    }
    logger.warn(`failed to download video from ${url}...`);
    return {
      downloadUrl: url,
      downloaded: false,
    } satisfies VideoVariant;
  }
}

async function downloadPhotoVariant(
  url: string,
  tempDir: string,
): Promise<PhotoVariant> {
  logger.debug(`downloading image from ${url}...`);
  let path: string | null = null;
  let newPath: string | null = null;
  try {
    path = await downloadFile(url, tempDir);
    logger.debug(`downloaded image to ${path}`);
    newPath = path + ".jpg";
    const downloadedPath = path;
    const recodedPath = newPath;
    logger.debug(`recoding image at ${path} to jpeg...`);
    await recodeImageToJpeg(path, newPath);
    logger.debug(`getting image resolution for ${newPath}...`);
    const resolution = await getImageResolution(newPath);
    logger.debug(`resolution: ${JSON.stringify(resolution)}`);

    return {
      payload: { resolution },
      downloaded: true,
      downloadUrl: url,
      path: recodedPath,
      size: Bun.file(recodedPath).size,
      cleanup: () => {
        Bun.file(downloadedPath).delete().catch();
        Bun.file(recodedPath).delete().catch();
      },
    } satisfies PhotoVariant;
  } catch {
    if (path) {
      Bun.file(path).delete().catch();
    }
    if (newPath) {
      Bun.file(newPath).delete().catch();
    }
    logger.warn(`failed to download image from ${url}`);
    return {
      downloaded: false,
      downloadUrl: url,
    } satisfies PhotoVariant;
  }
}

async function downloadMusicVariant(
  url: string,
  tempDir: string,
  contentName: string | null,
): Promise<MusicVariant> {
  logger.debug(`downloading music from ${url}...`);
  let path: string | null = null;
  try {
    path = await downloadFile(url, tempDir);
    const downloadedPath = path;
    logger.debug(`downloaded music to ${path}`);

    return {
      downloaded: true,
      downloadUrl: url,
      path: downloadedPath,
      size: Bun.file(downloadedPath).size,
      payload: { name: contentName || undefined },
      cleanup: () => {
        Bun.file(downloadedPath).delete().catch();
      },
    } satisfies MusicVariant;
  } catch {
    if (path) {
      Bun.file(path).delete().catch();
    }
    logger.warn(`failed to download music from ${url}`);
    return {
      downloaded: false,
      downloadUrl: url,
    } satisfies MusicVariant;
  }
}

function pickContentType(fetchers: Fetcher[]): DownloadContentType {
  const counts = new Map<DownloadContentType, number>();

  for (const fetcher of fetchers) {
    const type = fetcher.getType();
    if (!type) continue;
    counts.set(type, (counts.get(type) || 0) + 1);
  }

  let bestType: DownloadContentType | null = null;
  let bestCount = -1;
  for (const fetcher of fetchers) {
    const type = fetcher.getType();
    if (!type) continue;
    const count = counts.get(type) || 0;
    if (count > bestCount) {
      bestType = type;
      bestCount = count;
    }
  }

  if (!bestType) {
    throw new DownloadError("could not detect content type");
  }

  return bestType;
}

async function resolveDownloadInfo(
  url: string,
  downloadSources?: DownloadSource[],
): Promise<ResolvedDownloadInfo> {
  const fetcherClasses = downloadSources
    ? Array.from(new Set(downloadSources)).map((v) => fetcherMap[v])
    : Object.values(fetcherMap);
  let fetchers = fetcherClasses.map((C) => new C(url));

  await Promise.allSettled(
    fetchers.map(async (f) =>
      await withTimeout(
        f.fetchInfo(),
        FETCH_INFO_TIMEOUT_MS,
        `${f.constructor.name} fetchInfo`,
      ),
    ),
  );
  if (fetchers.every((f) => !f.isSuccessful())) {
    throw new DownloadError("all download sources failed");
  }

  fetchers = fetchers.filter((f) => f.getType() !== null);
  const contentType = pickContentType(fetchers);
  fetchers = fetchers.filter((f) => f.getType() === contentType);

  const contentName = fetchers.map((f) => f.getName()).find((n) => !!n) || null;
  const urls = zipArrays(fetchers.map((f) => f.getLinks()!));
  if (!urls.length) {
    throw new DownloadError("could not get download links");
  }

  return {
    contentType,
    contentName,
    urls,
  };
}

export async function downloadTiktok(
  url: string,
  downloadSources?: DownloadSource[],
  options: DownloadOptions = {},
): Promise<{ res: DownloadResult | null; cleanup: () => void }> {
  logger.debug(`downloading tiktok from ${url}...`);
  const tempDir = options.tempDir || config.get("TEMP_DIR");
  const strategy = options.strategy || "all";
  const maxFileSize = options.maxFileSize;
  const { contentType, contentName, urls } = await resolveDownloadInfo(
    url,
    downloadSources,
  );

  let res: DownloadResult | null = null;
  if (contentType === "video") {
    let variants: VideoVariant[] = [];

    if (strategy === "all") {
      variants = sortByResolution(
        await Promise.all(urls[0]!.map((variantUrl) => downloadVideoVariant(variantUrl, tempDir))),
      );
    } else {
      for (const variantUrl of urls[0]!) {
        const variant = await downloadVideoVariant(variantUrl, tempDir);
        variants.push(variant);
        if (
          variant.downloaded &&
          (maxFileSize === undefined || variant.size <= maxFileSize)
        ) {
          break;
        }
      }
    }

    res = {
      contentType: "video",
      variants,
    };
  } else if (contentType === "image") {
    const variants = await Promise.all(
      urls.map(async (img) => {
        if (strategy === "all") {
          return sortByResolution(
            await Promise.all(img.map((imageUrl) => downloadPhotoVariant(imageUrl, tempDir))),
          );
        }

        const attempted: PhotoVariant[] = [];
        for (const imageUrl of img) {
          const variant = await downloadPhotoVariant(imageUrl, tempDir);
          attempted.push(variant);
          if (variant.downloaded) {
            return attempted;
          }
        }

        return attempted.length
          ? attempted
          : [{ downloaded: false, downloadUrl: img[0]! } satisfies PhotoVariant];
      }),
    );
    res = {
      contentType: "image",
      variants,
    };
  } else if (contentType === "music") {
    const variants: MusicVariant[] = [];

    if (strategy === "all") {
      variants.push(
        ...(await Promise.all(
          urls[0]!.map((variantUrl) =>
            downloadMusicVariant(variantUrl, tempDir, contentName),
          ),
        )),
      );
    } else {
      for (const variantUrl of urls[0]!) {
        const variant = await downloadMusicVariant(
          variantUrl,
          tempDir,
          contentName,
        );
        variants.push(variant);
        if (
          variant.downloaded &&
          (maxFileSize === undefined || variant.size <= maxFileSize)
        ) {
          break;
        }
      }
    }

    res = {
      contentType: "music",
      variants,
    };
  }
  return {
    res,
    cleanup: () => {
      res?.variants.flat(1).forEach(cleanupVariant);
    },
  };
}
