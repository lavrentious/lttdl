import { randomUUIDv7 } from "bun";
import { existsSync, rmSync } from "fs";
import path from "path";
import { DownloadError } from "src/errors/download-error";
import { config } from "src/utils/env-validation";
import { logger } from "src/utils/logger";
import { getVideoResolution } from "src/utils/video";
import { AssetDownloader } from "../../asset-downloader";
import { AssetProcessor } from "../../asset-processor";
import type { PlatformHandler } from "../../platform-handler";
import type {
  DownloadExecutionResult,
  DownloadOptions,
  GalleryEntry,
  PhotoVariant,
  ResolvedVariant,
  VideoVariant,
} from "../../types";

const PINTEREST_DL_BINARY = "pinterest-dl";
const MAX_BOARD_ITEMS = 100;

type PinterestResolution = {
  x: number;
  y: number;
};

type PinterestVideo = {
  url: string;
  resolution?: [number, number];
  duration?: number;
};

type PinterestItem = {
  id: string | number;
  src: string;
  alt?: string;
  origin: string;
  resolution?: PinterestResolution;
  media_stream?: {
    video?: PinterestVideo;
  };
};

type PinterestCliResponse = {
  command: string;
  results?: Array<{
    input: string;
    items?: PinterestItem[];
  }>;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type PinterestHandlerDeps = {
  which: (binary: string) => string | null;
  runCommand: (cmd: string[]) => Promise<CommandResult>;
  downloadImageItem: (
    item: PinterestItem,
    tempDir: string,
  ) => Promise<PhotoVariant>;
  downloadVideoItem: (
    item: PinterestItem,
    tempDir: string,
    maxFileSize?: number,
  ) => Promise<VideoVariant>;
};

async function runCommand(cmd: string[]): Promise<CommandResult> {
  logger.debug(`running pinterest-dl command: ${cmd.join(" ")}`);
  const process = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  return {
    exitCode,
    stdout,
    stderr,
  };
}

async function downloadImageItem(
  item: PinterestItem,
  tempDir: string,
): Promise<PhotoVariant> {
  const assetProcessor = new AssetProcessor(new AssetDownloader());
  const variant = await assetProcessor.downloadImageVariant(
    {
      url: item.src,
      provider: "pinterest-dl",
      width: item.resolution?.x,
      height: item.resolution?.y,
    } satisfies ResolvedVariant,
    tempDir,
  );

  return {
    ...variant,
    downloadUrl: item.origin,
  };
}

async function downloadVideoItem(
  item: PinterestItem,
  tempDir: string,
  _maxFileSize?: number,
): Promise<VideoVariant> {
  const videoUrl = item.media_stream?.video?.url;
  if (!videoUrl) {
    return {
      downloaded: false,
      downloadUrl: item.origin,
    } satisfies VideoVariant;
  }

  const ffmpegPath = Bun.which("ffmpeg");
  if (!ffmpegPath) {
    logger.warn(
      "ffmpeg is not installed; pinterest video download will fall back to links",
    );
    return {
      downloaded: false,
      downloadUrl: item.origin,
    } satisfies VideoVariant;
  }

  const basename = randomUUIDv7();
  const outputPath = path.join(tempDir, `${basename}.mp4`);
  logger.debug(`downloading pinterest video from ${videoUrl} to ${outputPath}`);
  const { exitCode, stderr } = await runCommand([
    ffmpegPath,
    "-y",
    "-i",
    videoUrl,
    "-c",
    "copy",
    outputPath,
  ]);

  if (exitCode !== 0 || !existsSync(outputPath)) {
    logger.warn(`failed to download pinterest video: ${stderr.trim()}`);
    if (existsSync(outputPath)) {
      rmSync(outputPath);
    }
    return {
      downloaded: false,
      downloadUrl: item.origin,
    } satisfies VideoVariant;
  }

  const streamResolution = item.media_stream?.video?.resolution;
  const resolution =
    streamResolution &&
    streamResolution[0] &&
    streamResolution[1] &&
    streamResolution[0] > 0 &&
    streamResolution[1] > 0
      ? {
          width: streamResolution[0],
          height: streamResolution[1],
        }
      : await getVideoResolution(outputPath);

  return {
    downloaded: true,
    downloadUrl: item.origin,
    path: outputPath,
    size: Bun.file(outputPath).size,
    payload: { resolution },
    cleanup: () => {
      if (existsSync(outputPath)) {
        rmSync(outputPath);
      }
    },
  } satisfies VideoVariant;
}

function parseResponse(stdout: string): PinterestCliResponse {
  try {
    return JSON.parse(stdout) as PinterestCliResponse;
  } catch {
    throw new DownloadError("failed to parse pinterest-dl output");
  }
}

function classifyItem(item: PinterestItem): "image" | "video" {
  return item.media_stream?.video?.url ? "video" : "image";
}

export class PinterestPlatformHandler implements PlatformHandler {
  readonly platform = "pinterest" as const;

  constructor(
    private readonly deps: PinterestHandlerDeps = {
      which: (binary) => Bun.which(binary),
      runCommand,
      downloadImageItem,
      downloadVideoItem,
    },
  ) {}

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return ["pinterest.com", "pin.it"].some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
      );
    } catch {
      return false;
    }
  }

  async download(
    url: string,
    _context = {},
    options?: DownloadOptions,
  ): Promise<DownloadExecutionResult> {
    logger.debug(`starting pinterest download for ${url}`);
    if (!this.deps.which(PINTEREST_DL_BINARY)) {
      throw new DownloadError("pinterest-dl is not installed");
    }

    const tempDir = options?.tempDir || config.get("TEMP_DIR");
    const { exitCode, stdout, stderr } = await this.deps.runCommand([
      PINTEREST_DL_BINARY,
      "scrape",
      url,
      "--video",
      "--json",
    ]);

    if (exitCode !== 0) {
      logger.error(
        `pinterest-dl failed with exit code ${exitCode}: ${stderr.trim()}`,
      );
      throw new DownloadError("pinterest-dl failed");
    }

    const response = parseResponse(stdout);
    const items = response.results?.[0]?.items || [];
    if (!items.length) {
      throw new DownloadError("pinterest-dl returned no items");
    }

    const limitedItems = items.slice(0, MAX_BOARD_ITEMS);
    if (items.length > MAX_BOARD_ITEMS) {
      logger.warn(
        `pinterest board has ${items.length} items; limiting to first ${MAX_BOARD_ITEMS}`,
      );
    }

    const entries: GalleryEntry[] = [];
    for (const item of limitedItems) {
      if (classifyItem(item) === "video") {
        entries.push({
          kind: "video",
          variants: [
            await this.deps.downloadVideoItem(
              item,
              tempDir,
              options?.maxFileSize,
            ),
          ],
        });
      } else {
        entries.push({
          kind: "image",
          variants: [await this.deps.downloadImageItem(item, tempDir)],
        });
      }
    }

    const cleanup = () => {
      for (const entry of entries) {
        for (const variant of entry.variants) {
          variant.cleanup?.();
        }
      }
    };

    if (entries.length === 1) {
      const [entry] = entries;
      if (!entry) {
        throw new DownloadError("pinterest-dl returned no items");
      }

      return {
        res:
          entry.kind === "image"
            ? {
                contentType: "image",
                variants: [entry.variants],
              }
            : {
                contentType: "video",
                variants: entry.variants,
              },
        cleanup,
      };
    }

    if (entries.every((entry) => entry.kind === "image")) {
      return {
        res: {
          contentType: "image",
          variants: entries.map((entry) => entry.variants),
        },
        cleanup,
      };
    }

    return {
      res: {
        contentType: "gallery",
        entries,
      },
      cleanup,
    };
  }
}
