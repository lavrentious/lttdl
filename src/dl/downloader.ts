import { randomUUIDv7 } from "bun";
import path from "path";
import { DownloadError } from "src/errors/download-error";
import { zipArrays } from "src/utils/array";
import { mapWithConcurrency, retryAsync, withTimeout } from "src/utils/async";
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
const FETCH_INFO_RETRIES = 1;
const FILE_DOWNLOAD_RETRIES = 1;
const RETRY_DELAY_MS = 300;
const MAX_DOWNLOAD_CONCURRENCY = 8;
const MAX_IMAGE_ENTRY_CONCURRENCY = 8;

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`fetch timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getRemoteContentLength(url: string): Promise<number> {
  return await retryAsync(
    async () => {
      const res = await fetchWithTimeout(url, FETCH_INFO_TIMEOUT_MS, {
        method: "HEAD",
      });
      if (!res.ok) {
        throw new Error(`Failed to get content length: ${res.status}`);
      }

      return parseInt(res.headers.get("Content-Length") || "0");
    },
    {
      retries: FETCH_INFO_RETRIES,
      delayMs: RETRY_DELAY_MS,
      shouldRetry: isRetryableNetworkError,
    },
  );
}

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
  const arrayBuffer = await retryAsync(
    async () => {
      const res = await fetchWithTimeout(url, FILE_DOWNLOAD_TIMEOUT_MS);
      if (!res.ok) {
        throw new Error(`Failed to download: ${res.status}`);
      }

      return await res.arrayBuffer();
    },
    {
      retries: FILE_DOWNLOAD_RETRIES,
      delayMs: RETRY_DELAY_MS,
      shouldRetry: isRetryableNetworkError,
    },
  );
  await Bun.write(outputPath, arrayBuffer, { createPath: true });

  return outputPath;
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

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("socket") ||
    message.includes("connection")
  );
}

function cleanupVariant(variant: { cleanup?: () => void }) {
  try {
    variant.cleanup?.();
  } catch {}
}

function dedupeUrls(urls: string[]): string[] {
  return Array.from(new Set(urls));
}

function dedupeUrlGroups(urlGroups: string[][]): string[][] {
  return urlGroups.map((group) => dedupeUrls(group));
}

function sortByResolution<T extends VideoVariant | PhotoVariant>(
  variants: T[],
): T[] {
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
  maxFileSize?: number,
): Promise<VideoVariant> {
  logger.debug(`downloading video from ${url}...`);
  let path: string | null = null;
  try {
    if (maxFileSize !== undefined) {
      const remoteSize = await getRemoteContentLength(url).catch(() => 0);
      if (remoteSize > maxFileSize) {
        logger.debug(`skipping video download from ${url} (size ${remoteSize} exceeds limit ${maxFileSize})`);
        return {
          downloadUrl: url,
          downloaded: false,
        } satisfies VideoVariant;
      }
    }

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
  maxFileSize?: number,
): Promise<MusicVariant> {
  logger.debug(`downloading music from ${url}...`);
  let path: string | null = null;
  try {
    if (maxFileSize !== undefined) {
      const remoteSize = await getRemoteContentLength(url).catch(() => 0);
      if (remoteSize > maxFileSize) {
        logger.debug(`skipping music download from ${url} (size ${remoteSize} exceeds limit ${maxFileSize})`);
        return {
          downloaded: false,
          downloadUrl: url,
        } satisfies MusicVariant;
      }
    }

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
    fetchers.map(
      async (f) =>
        await retryAsync(
          async () =>
            await withTimeout(
              f.fetchInfo(),
              FETCH_INFO_TIMEOUT_MS,
              `${f.constructor.name} fetchInfo`,
            ),
          {
            retries: FETCH_INFO_RETRIES,
            delayMs: RETRY_DELAY_MS,
            shouldRetry: isRetryableNetworkError,
          },
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
  const urls = dedupeUrlGroups(zipArrays(fetchers.map((f) => f.getLinks()!)));
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
        await mapWithConcurrency(
          urls[0]!,
          MAX_DOWNLOAD_CONCURRENCY,
          async (variantUrl) =>
            await downloadVideoVariant(variantUrl, tempDir, maxFileSize),
        ),
      );
    } else {
      for (const variantUrl of urls[0]!) {
        const variant = await downloadVideoVariant(
          variantUrl,
          tempDir,
          maxFileSize,
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
      contentType: "video",
      variants,
    };
  } else if (contentType === "image") {
    const variants = await mapWithConcurrency(
      urls,
      MAX_IMAGE_ENTRY_CONCURRENCY,
      async (img) => {
        if (strategy === "all") {
          return sortByResolution(
            await mapWithConcurrency(
              img,
              MAX_DOWNLOAD_CONCURRENCY,
              async (imageUrl) => await downloadPhotoVariant(imageUrl, tempDir),
            ),
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
          : [
              {
                downloaded: false,
                downloadUrl: img[0]!,
              } satisfies PhotoVariant,
            ];
      },
    );
    res = {
      contentType: "image",
      variants,
    };
  } else if (contentType === "music") {
    const variants: MusicVariant[] = [];

    if (strategy === "all") {
      variants.push(
        ...(await mapWithConcurrency(
          urls[0]!,
          MAX_DOWNLOAD_CONCURRENCY,
          async (variantUrl) =>
            await downloadMusicVariant(
              variantUrl,
              tempDir,
              contentName,
              maxFileSize,
            ),
        )),
      );
    } else {
      for (const variantUrl of urls[0]!) {
        const variant = await downloadMusicVariant(
          variantUrl,
          tempDir,
          contentName,
          maxFileSize,
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
