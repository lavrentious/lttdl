import { config } from "src/utils/env-validation";
import { mapWithConcurrency } from "src/utils/async";
import { DownloadError, toDownloadError } from "src/errors/download-error";
import { AssetDownloader } from "./asset-downloader";
import { AssetProcessor } from "./asset-processor";
import type { PlatformHandler, ResolveContext } from "./platform-handler";
import { InstagramPlatformHandler } from "./platforms/instagram/instagram-platform-handler";
import { PinterestPlatformHandler } from "./platforms/pinterest/pinterest-platform-handler";
import { TiktokPlatformHandler } from "./platforms/tiktok/tiktok-platform-handler";
import { YoutubePlatformHandler } from "./platforms/youtube/youtube-platform-handler";
import type {
  DownloadExecutionResult,
  DownloadOptions,
  DownloadProgress,
  DownloadResult,
  GalleryEntry,
  MusicVariant,
  PhotoVariant,
  ResolvedContent,
  VideoVariant,
} from "./types";

const MAX_DOWNLOAD_CONCURRENCY = 8;
const MAX_IMAGE_ENTRY_CONCURRENCY = 8;

function cleanupVariant(variant: { cleanup?: () => void }) {
  try {
    variant.cleanup?.();
  } catch {}
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

export class DownloadRouter {
  constructor(private readonly handlers: readonly PlatformHandler[]) {}

  resolveHandler(url: string): PlatformHandler {
    const handler = this.handlers.find((candidate) => candidate.canHandle(url));
    if (!handler) {
      throw new DownloadError("unsupported link");
    }

    return handler;
  }
}

const defaultRouter = new DownloadRouter([
  new TiktokPlatformHandler(),
  new YoutubePlatformHandler(),
  new PinterestPlatformHandler(),
  new InstagramPlatformHandler(),
]);

const assetProcessor = new AssetProcessor(new AssetDownloader());

type AggregateDownloadState = {
  percent?: number;
  bytesDownloaded?: number;
  totalBytes?: number;
  speed?: string;
  eta?: string;
};

type AggregateDownloadSummary = {
  percentSum: number;
  percentCount: number;
  bytesDownloaded: number;
  totalBytes: number;
};

function createSequentialProgressMapper(
  options: {
    index: number;
    total: number;
    message: string;
    onProgress?: (progress: DownloadProgress) => void | Promise<void>;
  },
) {
  return async (progress: DownloadProgress) => {
    if (!options.onProgress) {
      return;
    }

    if (progress.stage !== "download") {
      await options.onProgress(progress);
      return;
    }

    const sequentialPercent =
      typeof progress.percent === "number"
        ? ((options.index + progress.percent / 100) / Math.max(options.total, 1)) * 100
        : undefined;

    await options.onProgress({
      stage: "download",
      message: options.message,
      percent: sequentialPercent,
      bytesDownloaded: progress.bytesDownloaded,
      totalBytes: progress.totalBytes,
      speed: progress.speed,
      eta: progress.eta,
    });
  };
}

function createAggregateProgressMapper(
  options: {
    total: number;
    message: string;
    onProgress?: (progress: DownloadProgress) => void | Promise<void>;
  },
) {
  const states: AggregateDownloadState[] = Array.from({ length: options.total }, () => ({}));

  return (index: number) =>
    async (progress: DownloadProgress) => {
      if (!options.onProgress) {
        return;
      }

      if (progress.stage !== "download") {
        await options.onProgress(progress);
        return;
      }

      states[index] = {
        percent: progress.percent,
        bytesDownloaded: progress.bytesDownloaded,
        totalBytes: progress.totalBytes,
        speed: progress.speed,
        eta: progress.eta,
      };

      const aggregate = states.reduce<AggregateDownloadSummary>(
        (acc, state) => {
          if (typeof state.percent === "number") {
            acc.percentSum += state.percent;
            acc.percentCount += 1;
          }

          if (typeof state.bytesDownloaded === "number") {
            acc.bytesDownloaded += state.bytesDownloaded;
          }

          if (typeof state.totalBytes === "number") {
            acc.totalBytes += state.totalBytes;
          }

          return acc;
        },
        {
          percentSum: 0,
          percentCount: 0,
          bytesDownloaded: 0,
          totalBytes: 0,
        },
      );

      const currentState = states[index];
      const totalBytes = aggregate.totalBytes > 0 ? aggregate.totalBytes : undefined;
      const bytesDownloaded =
        totalBytes !== undefined ? aggregate.bytesDownloaded : undefined;
      const percent =
        totalBytes !== undefined && totalBytes > 0
          ? (aggregate.bytesDownloaded / totalBytes) * 100
          : aggregate.percentCount > 0
            ? aggregate.percentSum / Math.max(options.total, 1)
            : undefined;

      await options.onProgress({
        stage: "download",
        message: options.message,
        percent,
        bytesDownloaded,
        totalBytes,
        speed: currentState?.speed,
        eta: currentState?.eta,
      });
    };
}

async function buildVideoResult(
  resolved: ResolvedContent,
  tempDir: string,
  strategy: NonNullable<DownloadOptions["strategy"]>,
  maxFileSize?: number,
  onProgress?: (progress: DownloadProgress) => void | Promise<void>,
): Promise<Extract<DownloadResult, { contentType: "video" }>> {
  const entry = resolved.entries[0];
  if (!entry) {
    throw new DownloadError("could not get download links");
  }

  const variants: VideoVariant[] = [];
  if (strategy === "all") {
    const progressMapper = createAggregateProgressMapper({
      total: entry.variants.length,
      message: "downloading video variants",
      onProgress,
    });
    variants.push(
      ...sortByResolution(
        await mapWithConcurrency(
          entry.variants,
          MAX_DOWNLOAD_CONCURRENCY,
          async (variant, index) =>
            await assetProcessor.downloadVideoVariant(
              variant,
              tempDir,
              maxFileSize,
              progressMapper(index),
            ),
        ),
      ),
    );
  } else {
    for (const [index, variant] of entry.variants.entries()) {
      const downloaded = await assetProcessor.downloadVideoVariant(
        variant,
        tempDir,
        maxFileSize,
        createSequentialProgressMapper({
          index,
          total: entry.variants.length,
          message: "downloading video",
          onProgress,
        }),
      );
      variants.push(downloaded);
      if (
        downloaded.downloaded &&
        (maxFileSize === undefined || downloaded.size <= maxFileSize)
      ) {
        break;
      }
    }
  }

  return {
    contentType: "video",
    variants,
  };
}

async function buildImageResult(
  resolved: ResolvedContent,
  tempDir: string,
  strategy: NonNullable<DownloadOptions["strategy"]>,
  onProgress?: (progress: DownloadProgress) => void | Promise<void>,
): Promise<Extract<DownloadResult, { contentType: "image" }>> {
  const variants = await mapWithConcurrency(
    resolved.entries,
    MAX_IMAGE_ENTRY_CONCURRENCY,
    async (entry, entryIndex) => {
      if (strategy === "all") {
        return sortByResolution(
          await mapWithConcurrency(
            entry.variants,
            MAX_DOWNLOAD_CONCURRENCY,
            async (variant) =>
              await assetProcessor.downloadImageVariant(variant, tempDir),
          ),
        );
      }

      const attempted: PhotoVariant[] = [];
      for (const variant of entry.variants) {
        const total = Math.max(resolved.entries.length, 1);
        const downloaded = await assetProcessor.downloadImageVariant(
          variant,
          tempDir,
          createSequentialProgressMapper({
            index: entryIndex,
            total,
            message: `downloading image ${entryIndex + 1}/${resolved.entries.length}`,
            onProgress,
          }),
        );
        attempted.push(downloaded);
        if (downloaded.downloaded) {
          return attempted;
        }
      }

      return attempted.length
        ? attempted
        : [
            {
              downloaded: false,
              downloadUrl: entry.variants[0]?.url || "",
            } satisfies PhotoVariant,
          ];
    },
  );

  return {
    contentType: "image",
    variants,
  };
}

async function buildAudioResult(
  resolved: ResolvedContent,
  tempDir: string,
  strategy: NonNullable<DownloadOptions["strategy"]>,
  maxFileSize?: number,
  onProgress?: (progress: DownloadProgress) => void | Promise<void>,
): Promise<Extract<DownloadResult, { contentType: "music" }>> {
  const entry = resolved.entries[0];
  if (!entry) {
    throw new DownloadError("could not get download links");
  }

  const variants: MusicVariant[] = [];
  if (strategy === "all") {
    const progressMapper = createAggregateProgressMapper({
      total: entry.variants.length,
      message: "downloading audio variants",
      onProgress,
    });
    variants.push(
      ...(await mapWithConcurrency(
        entry.variants,
        MAX_DOWNLOAD_CONCURRENCY,
        async (variant, index) =>
          await assetProcessor.downloadAudioVariant(
            variant,
            tempDir,
            resolved.title,
            maxFileSize,
            progressMapper(index),
          ),
      )),
    );
  } else {
    for (const [index, variant] of entry.variants.entries()) {
      const downloaded = await assetProcessor.downloadAudioVariant(
        variant,
        tempDir,
        resolved.title,
        maxFileSize,
        createSequentialProgressMapper({
          index,
          total: entry.variants.length,
          message: "downloading audio",
          onProgress,
        }),
      );
      variants.push(downloaded);
      if (
        downloaded.downloaded &&
        (maxFileSize === undefined || downloaded.size <= maxFileSize)
      ) {
        break;
      }
    }
  }

  return {
    contentType: "music",
    variants,
  };
}

export async function downloadContent(
  url: string,
  context: ResolveContext = {},
  options: DownloadOptions = {},
  router: DownloadRouter = defaultRouter,
): Promise<DownloadExecutionResult> {
  try {
    const handler = router.resolveHandler(url);
    if (handler.download) {
      return await handler.download(url, context, options);
    }

    if (!handler.resolve) {
      throw new DownloadError(`platform ${handler.platform} is not implemented`);
    }

    const resolved = await handler.resolve(url, context);
    const tempDir = options.tempDir || config.get("TEMP_DIR");
    const strategy = options.strategy || "all";
    const maxFileSize = options.maxFileSize;
    const onProgress = options.onProgress;

    let res: DownloadResult;
    if (resolved.kind === "video") {
      res = await buildVideoResult(
        resolved,
        tempDir,
        strategy,
        maxFileSize,
        onProgress,
      );
    } else if (resolved.kind === "image") {
      res = await buildImageResult(resolved, tempDir, strategy, onProgress);
    } else {
      res = await buildAudioResult(
        resolved,
        tempDir,
        strategy,
        maxFileSize,
        onProgress,
      );
    }

    return {
      res,
      cleanup: () => {
        res.variants.flat(1).forEach(cleanupVariant);
      },
    };
  } catch (error) {
    throw toDownloadError(error);
  }
}

export type {
  DownloadOptions,
  DownloadResult,
  GalleryEntry,
  MusicVariant,
  PhotoVariant,
  VideoVariant,
} from "./types";
