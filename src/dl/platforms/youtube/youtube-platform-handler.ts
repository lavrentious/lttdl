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
  formats?: YoutubeFormat[];
};

type YoutubeFormat = {
  format_id?: string;
  ext?: string;
  filesize?: number;
  filesize_approx?: number;
  tbr?: number;
  abr?: number;
  vbr?: number;
  width?: number;
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  protocol?: string;
};

type DownloadPlan = {
  kind: "video" | "audio";
  formatArgs: string[];
  postprocessArgs: string[];
  estimatedSizeBytes?: number;
  description: string;
  verboseDetails?: string;
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
    case "automatic":
      return [];
    case "best":
      return [
        "-f",
        "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "--merge-output-format",
        "mp4",
      ];
    case "fast-1080":
      return [
        "-f",
        "b[ext=mp4][height<=1080]/bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[height<=1080]/bv*[height<=1080]+ba/b",
        "--merge-output-format",
        "mp4",
      ];
    case "fast-720":
      return [
        "-f",
        "b[ext=mp4][height<=720]/bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[height<=720]/bv*[height<=720]+ba/b",
        "--merge-output-format",
        "mp4",
      ];
    case "best-audio":
      return ["-f", "ba", "-x", "--audio-format", "mp3"];
    case "mid-audio":
      return [
        "-f",
        "ba[abr<=128]/ba",
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "7",
      ];
  }
}

function getPresetPostprocessArgs(preset: YoutubePreset): string[] {
  switch (preset) {
    case "automatic":
    case "best":
    case "fast-1080":
    case "fast-720":
      return ["--merge-output-format", "mp4"];
    case "best-audio":
      return ["-x", "--audio-format", "mp3"];
    case "mid-audio":
      return ["-x", "--audio-format", "mp3", "--audio-quality", "7"];
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

function estimateFormatSizeBytes(
  format: YoutubeFormat,
  durationSeconds: number | undefined,
): number | undefined {
  if (typeof format.filesize === "number") {
    return format.filesize;
  }
  if (typeof format.filesize_approx === "number") {
    return format.filesize_approx;
  }
  if (!durationSeconds || durationSeconds <= 0) {
    return undefined;
  }

  const bitrateKbps =
    typeof format.tbr === "number"
      ? format.tbr
      : typeof format.vbr === "number" || typeof format.abr === "number"
        ? (format.vbr || 0) + (format.abr || 0)
        : undefined;
  if (!bitrateKbps || bitrateKbps <= 0) {
    return undefined;
  }

  return (bitrateKbps * 1000 * durationSeconds) / 8;
}

function formatHasVideo(format: YoutubeFormat): boolean {
  return !!format.vcodec && format.vcodec !== "none";
}

function formatHasAudio(format: YoutubeFormat): boolean {
  return !!format.acodec && format.acodec !== "none";
}

function formatCompatibilityScore(format: YoutubeFormat): number {
  let score = 0;
  if (format.ext === "mp4") {
    score += 10_000;
  }
  if (format.protocol === "https" || format.protocol === "http") {
    score += 2_000;
  }
  return score;
}

function chooseAutomaticPlan(
  metadata: YoutubeMetadata,
  maxFileSize?: number,
): DownloadPlan {
  const formats = metadata.formats || [];
  const duration = metadata.duration;

  const progressiveCandidates = formats
    .filter((format) => formatHasVideo(format) && formatHasAudio(format))
    .filter((format) => !!format.format_id)
    .map((format) => {
      const estimatedSizeBytes = estimateFormatSizeBytes(format, duration);
      return {
        kind: "video" as const,
        formatArgs: ["-f", format.format_id!],
        postprocessArgs: ["--merge-output-format", "mp4"],
        estimatedSizeBytes,
        description: `automatic progressive format ${format.format_id}`,
        verboseDetails: `automatic: ${format.height || "?"}p ${format.ext || "?"} progressive (${format.format_id})`,
        score:
          (format.height || 0) * 1_000_000 +
          (format.width || 0) * 1_000 +
          (format.fps || 0) * 100 +
          (format.tbr || 0) +
          formatCompatibilityScore(format),
      };
    });

  const audioFormats = formats
    .filter((format) => !formatHasVideo(format) && formatHasAudio(format))
    .filter((format) => !!format.format_id);

  const videoOnlyFormats = formats
    .filter((format) => formatHasVideo(format) && !formatHasAudio(format))
    .filter((format) => !!format.format_id);

  const mergedCandidates = videoOnlyFormats.flatMap((videoFormat) => {
    const bestAudio = [...audioFormats]
      .sort((a, b) => {
        const aScore = (a.abr || 0) + (a.tbr || 0) + formatCompatibilityScore(a);
        const bScore = (b.abr || 0) + (b.tbr || 0) + formatCompatibilityScore(b);
        return bScore - aScore;
      })
      .find((audioFormat) => {
        const videoSize = estimateFormatSizeBytes(videoFormat, duration);
        const audioSize = estimateFormatSizeBytes(audioFormat, duration);
        const estimatedSizeBytes =
          videoSize !== undefined && audioSize !== undefined
            ? videoSize + audioSize
            : undefined;
        return maxFileSize === undefined ||
          estimatedSizeBytes === undefined ||
          estimatedSizeBytes <= maxFileSize;
      });

    if (!bestAudio) {
      return [];
    }

    const videoSize = estimateFormatSizeBytes(videoFormat, duration);
    const audioSize = estimateFormatSizeBytes(bestAudio, duration);
    const estimatedSizeBytes =
      videoSize !== undefined && audioSize !== undefined
        ? videoSize + audioSize
        : undefined;

    return [
      {
        kind: "video" as const,
        formatArgs: ["-f", `${videoFormat.format_id!}+${bestAudio.format_id!}`],
        postprocessArgs: ["--merge-output-format", "mp4"],
        estimatedSizeBytes,
        description: `automatic merged formats ${videoFormat.format_id}+${bestAudio.format_id}`,
        verboseDetails:
          `automatic: ${videoFormat.height || "?"}p ${videoFormat.ext || "video"} + ` +
          `${bestAudio.ext || "audio"} (${videoFormat.format_id}+${bestAudio.format_id})`,
        score:
          (videoFormat.height || 0) * 1_000_000 +
          (videoFormat.width || 0) * 1_000 +
          (videoFormat.fps || 0) * 100 +
          (videoFormat.tbr || 0) +
          formatCompatibilityScore(videoFormat) +
          formatCompatibilityScore(bestAudio),
      },
    ];
  });

  const videoCandidates = [...progressiveCandidates, ...mergedCandidates]
    .filter(
      (candidate) =>
        maxFileSize === undefined ||
        candidate.estimatedSizeBytes === undefined ||
        candidate.estimatedSizeBytes <= maxFileSize,
    )
    .sort((a, b) => b.score - a.score);

  const bestVideo = videoCandidates[0];
  if (bestVideo) {
    return {
      kind: "video",
      formatArgs: bestVideo.formatArgs,
      postprocessArgs: bestVideo.postprocessArgs,
      estimatedSizeBytes: bestVideo.estimatedSizeBytes,
      description: bestVideo.description,
      verboseDetails: bestVideo.verboseDetails,
    };
  }

  const audioCandidates = audioFormats
    .map((format) => ({
      kind: "audio" as const,
      formatArgs: ["-f", format.format_id!],
      postprocessArgs: ["-x", "--audio-format", "mp3"],
      estimatedSizeBytes: estimateFormatSizeBytes(format, duration),
      description: `automatic audio format ${format.format_id}`,
      verboseDetails: `automatic: audio ${format.abr || format.tbr || "?"}kbps (${format.format_id})`,
      score: (format.abr || 0) * 1_000 + (format.tbr || 0) + formatCompatibilityScore(format),
    }))
    .filter(
      (candidate) =>
        maxFileSize === undefined ||
        candidate.estimatedSizeBytes === undefined ||
        candidate.estimatedSizeBytes <= maxFileSize,
    )
    .sort((a, b) => b.score - a.score);

  const bestAudio = audioCandidates[0];
  if (bestAudio) {
    return {
      kind: "audio",
      formatArgs: bestAudio.formatArgs,
      postprocessArgs: bestAudio.postprocessArgs,
      estimatedSizeBytes: bestAudio.estimatedSizeBytes,
      description: bestAudio.description,
      verboseDetails: bestAudio.verboseDetails,
    };
  }

  throw new DownloadError(
    buildOversizeMessage({
      estimatedSizeBytes:
        typeof duration === "number"
          ? estimateVideoSizeFromDuration(duration)
          : undefined,
      exact: false,
    }),
  );
}

function buildDownloadPlan(
  preset: YoutubePreset,
  metadata: YoutubeMetadata,
  maxFileSize?: number,
): DownloadPlan {
  if (preset === "automatic") {
    return chooseAutomaticPlan(metadata, maxFileSize);
  }

  return {
    kind: preset === "best-audio" || preset === "mid-audio" ? "audio" : "video",
    formatArgs: getPresetArgs(preset),
    postprocessArgs: getPresetPostprocessArgs(preset),
    estimatedSizeBytes:
      typeof metadata.filesize === "number"
        ? metadata.filesize
        : typeof metadata.filesize_approx === "number"
          ? metadata.filesize_approx
          : undefined,
    description: `preset ${preset}`,
  };
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
  kind: DownloadPlan["kind"],
): string {
  if (kind === "audio") {
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
    const plan = buildDownloadPlan(preset, metadata, options?.maxFileSize);
    const estimatedSize = plan.estimatedSizeBytes;
    if (
      options?.maxFileSize !== undefined &&
      ((estimatedSize !== undefined && estimatedSize > options.maxFileSize) ||
        (estimatedSize === undefined &&
          plan.kind === "video" &&
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
        : preset === "automatic"
          ? `youtube automatic preset selected ${plan.description}`
        : preset === "fast-1080"
          ? "youtube fast-1080 preset using capped 1080p mp4-first selection"
          : preset === "fast-720"
            ? "youtube fast-720 preset using capped 720p mp4-first selection"
            : preset === "best-audio"
              ? "youtube best-audio preset using audio extraction to mp3"
              : "youtube mid-audio preset using reduced bitrate mp3 extraction",
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
      ...plan.formatArgs,
      ...plan.postprocessArgs,
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
    const finalPath = resolveFinalPath(tempDir, basename, plan.kind);
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

    if (plan.kind === "audio") {
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
                details: plan.verboseDetails,
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
            payload: {
              resolution,
              details: plan.verboseDetails,
            },
            cleanup,
          },
        ],
      },
      cleanup,
    };
  }
}
