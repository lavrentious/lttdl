import { randomUUIDv7 } from "bun";
import { existsSync, readdirSync, rmSync } from "fs";
import path from "path";
import { DownloadError } from "src/errors/download-error";
import {
  buildOversizeMessage,
  estimateVideoSizeFromDuration,
  isLikelyOversizeVideo,
} from "src/dl/size-guard";
import { config } from "src/utils/env-validation";
import { logger } from "src/utils/logger";
import { getVideoResolution } from "src/utils/video";
import type { PlatformHandler, ResolveContext } from "../../platform-handler";
import type {
  DownloadExecutionResult,
  DownloadOptions,
  DownloadProgress,
  YoutubePreset,
} from "../../types";

type YoutubeMetadata = {
  title?: string;
  width?: number;
  height?: number;
  webpage_url?: string;
  duration?: number;
  filesize?: number;
  filesize_approx?: number;
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

type YoutubeHandlerDeps = {
  which: (binary: string) => string | null;
  runCommand: (cmd: string[], hooks?: CommandHooks) => Promise<CommandResult>;
  getVideoResolution: (filePath: string) => Promise<{ width: number; height: number }>;
};

const YT_DLP_BINARY = "yt-dlp";

function parseSizeToBytes(size: string): number | undefined {
  const normalized = size.replace(/~/g, "").trim();
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?i?B)$/i);
  if (!match) {
    return undefined;
  }

  const value = Number(match[1]);
  const unit = match[2]!.toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4,
  };

  const multiplier = multipliers[unit];
  return multiplier ? value * multiplier : undefined;
}

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
  logger.debug(`running yt-dlp command: ${cmd.join(" ")}`);
  const process = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    readStream(process.stdout, hooks.onStdoutLine),
    readStream(process.stderr, hooks.onStderrLine),
  ]);

  return {
    exitCode,
    stdout,
    stderr,
  };
}

function getPresetArgs(preset: YoutubePreset): string[] {
  switch (preset) {
    case "best":
      return [
        "-f",
        "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "--merge-output-format",
        "mp4",
      ];
    case "best-audio":
      return ["-f", "ba", "-x", "--audio-format", "mp3"];
  }
}

function parseMetadata(stdout: string): YoutubeMetadata {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate = lines.at(-1);

  if (!candidate) {
    return {};
  }

  try {
    return JSON.parse(candidate) as YoutubeMetadata;
  } catch {
    return {};
  }
}

async function fetchMetadata(
  runCommandImpl: YoutubeHandlerDeps["runCommand"],
  url: string,
): Promise<YoutubeMetadata> {
  const { exitCode, stdout, stderr } = await runCommandImpl([
    YT_DLP_BINARY,
    "--no-playlist",
    "--dump-single-json",
    url,
  ]);

  if (exitCode !== 0) {
    throw new DownloadError(stderr.trim() || "yt-dlp metadata fetch failed");
  }

  return parseMetadata(stdout);
}

function parseProgressLine(line: string): DownloadProgress | null {
  const percentMatch = line.match(
    /^\[download\]\s+(\d+(?:\.\d+)?)% of\s+(.+?)(?: at\s+(.+?)\s+ETA\s+(.+))?$/,
  );
  if (percentMatch) {
    const totalBytes = parseSizeToBytes(percentMatch[2] || "");
    const percent = Number(percentMatch[1]);
    return {
      stage: "download",
      percent,
      bytesDownloaded:
        totalBytes !== undefined ? (totalBytes * percent) / 100 : undefined,
      totalBytes,
      speed: percentMatch[3]?.trim(),
      eta: percentMatch[4]?.trim(),
    };
  }

  if (
    line.startsWith("[Merger]") ||
    line.startsWith("[VideoRemuxer]") ||
    line.startsWith("[ExtractAudio]") ||
    line.startsWith("[Fixup")
  ) {
    return {
      stage: "postprocess",
      message: line.replace(/^\[[^\]]+\]\s*/, ""),
    };
  }

  return null;
}

async function emitProgressFromLine(
  line: string,
  onProgress?: (progress: DownloadProgress) => void | Promise<void>,
) {
  const progress = parseProgressLine(line);
  if (!progress) {
    return;
  }

  logger.debug(`yt-dlp progress: ${JSON.stringify(progress)}`);
  await onProgress?.(progress);
}

function resolveFinalPath(
  tempDir: string,
  basename: string,
  preset: YoutubePreset,
): string {
  if (preset === "best-audio") {
    const expectedPath = path.join(tempDir, `${basename}.mp3`);
    if (existsSync(expectedPath)) {
      logger.debug(`resolved yt-dlp audio output path: ${expectedPath}`);
      return expectedPath;
    }
  } else {
    const preferredPath = path.join(tempDir, `${basename}.mp4`);
    if (existsSync(preferredPath)) {
      logger.debug(`resolved yt-dlp video output path as mp4: ${preferredPath}`);
      return preferredPath;
    }
  }

  const matchedPath = readdirSync(tempDir)
    .filter((entry) => entry.startsWith(`${basename}.`))
    .filter((entry) => !entry.endsWith(".part"))
    .map((entry) => path.join(tempDir, entry))
    .find((entryPath) => existsSync(entryPath));
  if (matchedPath) {
    logger.debug(`resolved yt-dlp fallback output path: ${matchedPath}`);
    return matchedPath;
  }

  throw new DownloadError("yt-dlp completed but produced no output file");
}

export class YoutubePlatformHandler implements PlatformHandler {
  readonly platform = "youtube" as const;

  constructor(
    private readonly deps: YoutubeHandlerDeps = {
      which: (binary) => Bun.which(binary),
      runCommand,
      getVideoResolution,
    },
  ) {}

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return hostname.includes("youtube.com") || hostname === "youtu.be";
    } catch {
      return false;
    }
  }

  async download(
    url: string,
    context?: ResolveContext,
    options?: DownloadOptions,
  ): Promise<DownloadExecutionResult> {
    logger.debug(`starting youtube download for ${url}`);
    if (!this.deps.which(YT_DLP_BINARY)) {
      logger.debug("yt-dlp binary not found in PATH");
      throw new DownloadError("yt-dlp is not installed");
    }

    const preset = context?.youtubePreset || "best";
    const tempDir = options?.tempDir || config.get("TEMP_DIR");
    const basename = randomUUIDv7();
    const outputTemplate = path.join(tempDir, `${basename}.%(ext)s`);
    const metadata = await fetchMetadata(this.deps.runCommand, url);
    const estimatedSize =
      typeof metadata.filesize === "number"
        ? metadata.filesize
        : typeof metadata.filesize_approx === "number"
          ? metadata.filesize_approx
          : undefined;
    if (
      options?.maxFileSize !== undefined &&
      ((estimatedSize !== undefined && estimatedSize > options.maxFileSize) ||
        (estimatedSize === undefined &&
          preset === "best" &&
          isLikelyOversizeVideo(metadata.duration, options.maxFileSize)))
    ) {
      throw new DownloadError(
        buildOversizeMessage({
          estimatedSizeBytes:
            estimatedSize !== undefined
              ? estimatedSize
              : metadata.duration !== undefined
                ? estimateVideoSizeFromDuration(metadata.duration)
                : undefined,
          exact: estimatedSize !== undefined,
        }),
      );
    }
    logger.debug(
      preset === "best"
        ? "youtube best preset using mp4-first fast path with merge/remux only"
        : "youtube best-audio preset using audio extraction to mp3",
    );
    logger.debug(
      `youtube preset=${preset}, tempDir=${tempDir}, outputTemplate=${outputTemplate}`,
    );
    const { exitCode, stdout, stderr } = await this.deps.runCommand([
      YT_DLP_BINARY,
      "--no-playlist",
      "--print-json",
      "--progress",
      "--newline",
      "--output",
      outputTemplate,
      ...getPresetArgs(preset),
      url,
    ], {
      onStdoutLine: async (line) => {
        await emitProgressFromLine(line, options?.onProgress);
      },
      onStderrLine: async (line) => {
        await emitProgressFromLine(line, options?.onProgress);
      },
    });
    logger.debug(`yt-dlp exited with code ${exitCode}`);

    if (exitCode !== 0) {
      logger.debug(`yt-dlp stderr: ${stderr.trim()}`);
      throw new DownloadError(stderr.trim() || "yt-dlp failed");
    }

    const runtimeMetadata = {
      ...metadata,
      ...parseMetadata(stdout),
    };
    logger.debug(`yt-dlp metadata: ${JSON.stringify(runtimeMetadata)}`);
    const finalPath = resolveFinalPath(tempDir, basename, preset);
    logger.debug(
      `youtube final container: ${path.extname(finalPath).replace(/^\./, "") || "unknown"}`,
    );
    await options?.onProgress?.({
      stage: "completed",
      message: "download complete",
    });
    const cleanup = () => {
      if (existsSync(finalPath)) {
        logger.debug(`cleaning up youtube download at ${finalPath}`);
        rmSync(finalPath);
      }
    };

    if (preset === "best-audio") {
      logger.debug(`youtube audio ready at ${finalPath}`);
      return {
        res: {
          contentType: "music",
          variants: [
            {
              downloaded: true,
              downloadUrl: runtimeMetadata.webpage_url || url,
              path: finalPath,
              size: Bun.file(finalPath).size,
              payload: {
                name: runtimeMetadata.title,
              },
              cleanup,
            },
          ],
        },
        cleanup,
      };
    }

    const resolution =
      typeof runtimeMetadata.width === "number" &&
      typeof runtimeMetadata.height === "number"
        ? { width: runtimeMetadata.width, height: runtimeMetadata.height }
        : await this.deps.getVideoResolution(finalPath);
    logger.debug(
      `youtube video ready at ${finalPath} with resolution ${resolution.width}x${resolution.height}`,
    );

    return {
      res: {
        contentType: "video",
        variants: [
          {
            downloaded: true,
            downloadUrl: runtimeMetadata.webpage_url || url,
            path: finalPath,
            size: Bun.file(finalPath).size,
            payload: { resolution },
            cleanup,
          },
        ],
      },
      cleanup,
    };
  }
}
