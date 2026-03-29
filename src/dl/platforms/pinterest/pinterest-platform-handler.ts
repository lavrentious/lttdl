import { randomUUIDv7 } from "bun";
import { existsSync, rmSync } from "fs";
import path from "path";
import { DownloadError } from "src/errors/download-error";
import { config } from "src/utils/env-validation";
import { logger } from "src/utils/logger";
import { isLikelyOversizeVideo } from "src/dl/size-guard";
import { getVideoMetadata } from "src/utils/video";
import { AssetDownloader } from "../../asset-downloader";
import { AssetProcessor } from "../../asset-processor";
import type { PlatformHandler } from "../../platform-handler";
import type {
  DownloadExecutionResult,
  DownloadOptions,
  DownloadProgress,
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

type CommandHooks = {
  onStdoutLine?: (line: string) => void | Promise<void>;
  onStderrLine?: (line: string) => void | Promise<void>;
};

type PinterestHandlerDeps = {
  which: (binary: string) => string | null;
  runCommand: (cmd: string[], hooks?: CommandHooks) => Promise<CommandResult>;
  downloadImageItem: (
    item: PinterestItem,
    tempDir: string,
    onProgress?: (progress: DownloadProgress) => void | Promise<void>,
  ) => Promise<PhotoVariant>;
  downloadVideoItem: (
    item: PinterestItem,
    tempDir: string,
    maxFileSize?: number,
    onProgress?: (progress: DownloadProgress) => void | Promise<void>,
  ) => Promise<VideoVariant>;
};

async function readStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onLine?: (line: string) => void | Promise<void>,
): Promise<string> {
  if (!stream) {
    return "";
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = decoder.decode(value, { stream: true });
    output += chunk;
    buffer += chunk;

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        await onLine?.(line);
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }

  const tail = decoder.decode();
  if (tail) {
    output += tail;
    buffer += tail;
  }

  const finalLine = buffer.trim();
  if (finalLine) {
    await onLine?.(finalLine);
  }

  return output;
}

async function runCommand(cmd: string[], hooks: CommandHooks = {}): Promise<CommandResult> {
  logger.debug(`running command: ${cmd.join(" ")}`);
  const spawned = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    spawned.exited,
    readStream(spawned.stdout, hooks.onStdoutLine),
    readStream(spawned.stderr, hooks.onStderrLine),
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
  onProgress?: (progress: DownloadProgress) => void | Promise<void>,
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
    onProgress,
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
  onProgress?: (progress: DownloadProgress) => void | Promise<void>,
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
  const durationSeconds =
    typeof item.media_stream?.video?.duration === "number" &&
    item.media_stream.video.duration > 0
      ? item.media_stream.video.duration
      : undefined;
  if (isLikelyOversizeVideo(durationSeconds, _maxFileSize)) {
    logger.debug(
      `skipping pinterest video download for ${item.origin} due to duration heuristic (${durationSeconds}s likely exceeds limit ${_maxFileSize})`,
    );
    return {
      downloaded: false,
      downloadUrl: item.origin,
    } satisfies VideoVariant;
  }
  const progressState: {
    bytesDownloaded?: number;
    outTimeSeconds?: number;
    speed?: string;
  } = {};
  logger.debug(`downloading pinterest video from ${videoUrl} to ${outputPath}`);
  await onProgress?.({
    stage: "postprocess",
    message: `downloading video stream for ${item.origin}`,
  });
  const { exitCode, stderr } = await runCommand([
    ffmpegPath,
    "-y",
    "-nostats",
    "-progress",
    "pipe:2",
    "-i",
    videoUrl,
    "-c",
    "copy",
    outputPath,
  ], {
    onStderrLine: async (line) => {
      const [key, rawValue = ""] = line.split("=", 2);
      const value = rawValue.trim();

      if (!key) {
        return;
      }

      if (key === "total_size") {
        const bytesDownloaded = Number(value);
        if (Number.isFinite(bytesDownloaded) && bytesDownloaded >= 0) {
          progressState.bytesDownloaded = bytesDownloaded;
        }
      } else if (key === "out_time_ms") {
        const outTimeMs = Number(value);
        if (Number.isFinite(outTimeMs) && outTimeMs >= 0) {
          progressState.outTimeSeconds = outTimeMs / 1_000_000;
        }
      } else if (key === "speed") {
        progressState.speed = value;
      } else if (key !== "progress") {
        return;
      }

      if (key === "progress" && value === "continue") {
        await onProgress?.({
          stage: "download",
          message: "downloading pinterest video",
          percent:
            durationSeconds && progressState.outTimeSeconds !== undefined
              ? Math.min((progressState.outTimeSeconds / durationSeconds) * 100, 100)
              : undefined,
          bytesDownloaded: progressState.bytesDownloaded,
          speed: progressState.speed,
          eta:
            durationSeconds &&
            progressState.outTimeSeconds !== undefined &&
            progressState.speed &&
            progressState.outTimeSeconds < durationSeconds
              ? `${Math.max(
                  Math.ceil(durationSeconds - progressState.outTimeSeconds),
                  0,
                )}s`
              : undefined,
        });
      } else if (key === "progress" && value === "end") {
        await onProgress?.({
          stage: "download",
          message: "downloading pinterest video",
          percent: 100,
          bytesDownloaded: progressState.bytesDownloaded,
          speed: progressState.speed,
        });
      }
    },
  });

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
  const localMetadata = await getVideoMetadata(outputPath).catch(() => undefined);
  const resolution =
    localMetadata
      ? {
          width: localMetadata.width,
          height: localMetadata.height,
        }
      :
    streamResolution &&
    streamResolution[0] &&
    streamResolution[1] &&
    streamResolution[0] > 0 &&
    streamResolution[1] > 0
      ? {
          width: streamResolution[0],
          height: streamResolution[1],
        }
      : { width: 0, height: 0 };

  return {
    downloaded: true,
    downloadUrl: item.origin,
    path: outputPath,
    size: Bun.file(outputPath).size,
    payload: {
      resolution,
      durationSeconds: localMetadata?.durationSeconds ?? durationSeconds,
    },
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

    await options?.onProgress?.({
      stage: "status",
      message: "resolving pinterest items...",
    });
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
    for (const [index, item] of limitedItems.entries()) {
      await options?.onProgress?.({
        stage: "batch",
        current: index,
        total: limitedItems.length,
        message: `processing pinterest item ${index + 1}/${limitedItems.length}`,
      });

      const perItemProgress = async (progress: DownloadProgress) => {
        if (!options?.onProgress) {
          return;
        }

        if (progress.stage === "download") {
          const aggregatePercent =
            typeof progress.percent === "number"
              ? ((index + progress.percent / 100) / Math.max(limitedItems.length, 1)) * 100
              : undefined;

          await options.onProgress({
            stage: "download",
            message: `downloading pinterest item ${index + 1}/${limitedItems.length}`,
            percent: aggregatePercent,
            bytesDownloaded: progress.bytesDownloaded,
            totalBytes: progress.totalBytes,
            speed: progress.speed,
            eta: progress.eta,
          });
          return;
        }

        await options.onProgress(progress);
      };

      if (classifyItem(item) === "video") {
        entries.push({
          kind: "video",
          variants: [
            await this.deps.downloadVideoItem(
              item,
              tempDir,
              options?.maxFileSize,
              perItemProgress,
            ),
          ],
        });
      } else {
        entries.push({
          kind: "image",
          variants: [await this.deps.downloadImageItem(item, tempDir, perItemProgress)],
        });
      }
    }

    await options?.onProgress?.({
      stage: "completed",
      message: "pinterest download complete",
    });

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
