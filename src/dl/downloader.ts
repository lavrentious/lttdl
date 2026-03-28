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

const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

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
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download: ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  await Bun.write(outputPath, arrayBuffer, { createPath: true });
  return outputPath;
}

export enum DownloadSource {
  V1 = "v1",
  V2 = "v2",
  V3 = "v3",
}
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
export async function downloadTiktok(
  url: string,
  downloadSources?: DownloadSource[],
  tempDir?: string,
): Promise<{ res: DownloadResult | null; cleanup: () => void }> {
  if (!tempDir) {
    tempDir = config.get("TEMP_DIR");
  }

  logger.debug(`downloading tiktok from ${url}...`);

  const fetcherClasses = downloadSources
    ? Array.from(new Set(downloadSources)).map((v) => fetcherMap[v])
    : Object.values(fetcherMap);
  let fetchers = fetcherClasses.map((C) => new C(url));

  await Promise.allSettled(fetchers.map(async (f) => await f.fetchInfo()));
  if (fetchers.every((f) => !f.isSuccessful())) {
    throw new DownloadError("all download sources failed");
  }
  fetchers = fetchers.filter((f) => f.getType() !== null);
  const fetchedTypes = fetchers.map((f) => f.getType());

  if (Array.from(new Set(fetchedTypes)).length !== 1) {
    throw new DownloadError("could not detect content type");
  }
  const contentType = fetchedTypes[0]!;
  const contentName = fetchers.map((f) => f.getName()).find((n) => !!n);

  const urls = zipArrays(fetchers.map((f) => f.getLinks()!));
  if (!urls.length) {
    throw new DownloadError("could not get download links");
  }

  let res: DownloadResult | null = null;
  if (contentType === "video") {
    const variants = (
      (await Promise.all(
        urls[0]!.map(async (url) => {
          logger.debug(`downloading video from ${url}...`);
          try {
            const path = await downloadFile(url);
            logger.debug(`downloaded video to ${path}`);
            logger.debug(`getting video resolution for ${path}...`);
            const res = await getVideoResolution(path);
            logger.debug(`resolution: ${JSON.stringify(res)}`);

            return {
              payload: { resolution: res },
              downloaded: true,
              downloadUrl: url,
              path,
              size: Bun.file(path).size,
              cleanup: () => {
                Bun.file(path).delete().catch();
              },
            } satisfies VideoVariant;
          } catch {
            logger.warn(`failed to download video from ${url}...`);
            return {
              downloadUrl: url,
              downloaded: false,
            } satisfies VideoVariant;
          }
        }),
      )) as VideoVariant[]
    ).sort((a, b) =>
      a.downloaded && b.downloaded
        ? b.payload.resolution.width * b.payload.resolution.height -
          a.payload.resolution.width * a.payload.resolution.height
        : 0,
    );
    res = {
      contentType: "video",
      variants,
    };
  } else if (contentType === "image") {
    const variants = await Promise.all(
      urls.map(async (img) =>
        (
          (await Promise.all(
            img.map(async (url) => {
              logger.debug(`downloading image from ${url}...`);
              try {
                const path = await downloadFile(url);
                logger.debug(`downloaded image to ${path}`);
                const newPath = path + ".jpg";
                logger.debug(`recoding image at ${path} to jpeg...`);
                await recodeImageToJpeg(path, newPath);
                logger.debug(`getting image resolution for ${newPath}...`);
                const res = await getImageResolution(newPath);
                logger.debug(`resolution: ${JSON.stringify(res)}`);

                return {
                  payload: { resolution: res },
                  downloaded: true,
                  downloadUrl: url,
                  path: newPath,
                  size: Bun.file(newPath).size,
                  cleanup: () => {
                    Bun.file(path).delete().catch();
                    Bun.file(newPath).delete().catch();
                  },
                } satisfies PhotoVariant;
              } catch {
                logger.warn(`failed to download image from ${url}`);
                return {
                  downloaded: false,
                  downloadUrl: url,
                } satisfies PhotoVariant;
              }
            }),
          )) as PhotoVariant[]
        ).sort((a, b) =>
          a.downloaded && b.downloaded
            ? b.payload.resolution.width * b.payload.resolution.height -
              a.payload.resolution.width * a.payload.resolution.height
            : 0,
        ),
      ),
    );
    res = {
      contentType: "image",
      variants,
    };
  } else if (contentType === "music") {
    const variants = (await Promise.all(
      urls[0]!.map(async (url) => {
        logger.debug(`downloading music from ${url}...`);
        try {
          const path = await downloadFile(url);
          logger.debug(`downloaded music to ${path}`);

          return {
            downloaded: true,
            downloadUrl: url,
            path,
            size: Bun.file(path).size,
            payload: { name: contentName || undefined },
            cleanup: () => {
              Bun.file(path).delete().catch();
            },
          } satisfies MusicVariant;
        } catch {
          logger.warn(`failed to download music from ${url}`);
          return {
            downloaded: false,
            downloadUrl: url,
          } satisfies MusicVariant;
        }
      }),
    )) as MusicVariant[];
    res = {
      contentType: "music",
      variants,
    };
  }
  return {
    res,
    cleanup: () => {
      res?.variants.flat(1).map((v) => v.cleanup?.());
    },
  };
}
