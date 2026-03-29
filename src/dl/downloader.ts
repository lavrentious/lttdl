import { config } from "src/utils/env-validation";
import { mapWithConcurrency } from "src/utils/async";
import { DownloadError } from "src/errors/download-error";
import { AssetDownloader } from "./asset-downloader";
import { AssetProcessor } from "./asset-processor";
import type { PlatformHandler, ResolveContext } from "./platform-handler";
import { PinterestPlatformHandler } from "./platforms/pinterest/pinterest-platform-handler";
import { TiktokPlatformHandler } from "./platforms/tiktok/tiktok-platform-handler";
import { YoutubePlatformHandler } from "./platforms/youtube/youtube-platform-handler";
import type {
  DownloadExecutionResult,
  DownloadOptions,
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
]);

const assetProcessor = new AssetProcessor(new AssetDownloader());

async function buildVideoResult(
  resolved: ResolvedContent,
  tempDir: string,
  strategy: NonNullable<DownloadOptions["strategy"]>,
  maxFileSize?: number,
): Promise<Extract<DownloadResult, { contentType: "video" }>> {
  const entry = resolved.entries[0];
  if (!entry) {
    throw new DownloadError("could not get download links");
  }

  const variants: VideoVariant[] = [];
  if (strategy === "all") {
    variants.push(
      ...sortByResolution(
        await mapWithConcurrency(
          entry.variants,
          MAX_DOWNLOAD_CONCURRENCY,
          async (variant) =>
            await assetProcessor.downloadVideoVariant(variant, tempDir, maxFileSize),
        ),
      ),
    );
  } else {
    for (const variant of entry.variants) {
      const downloaded = await assetProcessor.downloadVideoVariant(
        variant,
        tempDir,
        maxFileSize,
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
): Promise<Extract<DownloadResult, { contentType: "image" }>> {
  const variants = await mapWithConcurrency(
    resolved.entries,
    MAX_IMAGE_ENTRY_CONCURRENCY,
    async (entry) => {
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
        const downloaded = await assetProcessor.downloadImageVariant(variant, tempDir);
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
): Promise<Extract<DownloadResult, { contentType: "music" }>> {
  const entry = resolved.entries[0];
  if (!entry) {
    throw new DownloadError("could not get download links");
  }

  const variants: MusicVariant[] = [];
  if (strategy === "all") {
    variants.push(
      ...(await mapWithConcurrency(
        entry.variants,
        MAX_DOWNLOAD_CONCURRENCY,
        async (variant) =>
          await assetProcessor.downloadAudioVariant(
            variant,
            tempDir,
            resolved.title,
            maxFileSize,
          ),
      )),
    );
  } else {
    for (const variant of entry.variants) {
      const downloaded = await assetProcessor.downloadAudioVariant(
        variant,
        tempDir,
        resolved.title,
        maxFileSize,
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

  let res: DownloadResult;
  if (resolved.kind === "video") {
    res = await buildVideoResult(resolved, tempDir, strategy, maxFileSize);
  } else if (resolved.kind === "image") {
    res = await buildImageResult(resolved, tempDir, strategy);
  } else {
    res = await buildAudioResult(resolved, tempDir, strategy, maxFileSize);
  }

  return {
    res,
    cleanup: () => {
      res.variants.flat(1).forEach(cleanupVariant);
    },
  };
}

export type {
  DownloadOptions,
  DownloadResult,
  GalleryEntry,
  MusicVariant,
  PhotoVariant,
  VideoVariant,
} from "./types";
