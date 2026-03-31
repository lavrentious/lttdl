import { randomUUIDv7 } from "bun";
import { existsSync, rmSync } from "fs";
import path from "path";
import { DownloadError } from "src/errors/download-error";
import {
  buildOversizeMessage,
  estimateVideoSizeFromDuration,
  isLikelyOversizeVideo,
} from "src/dl/size-guard";
import { config } from "src/utils/env-validation";
import { logger } from "src/utils/logger";
import { getAudioDuration, getVideoMetadata, getVideoResolution } from "src/utils/video";
import { DEFAULT_YOUTUBE_PRESET } from "./types";
import {
  buildYtDlpArgs,
  emitProgressFromYtDlpLine,
  parseYtDlpMetadata,
  resolveYtDlpFinalPath,
  runYtDlpCommand,
  YT_DLP_BINARY,
  type YtDlpCommandHooks,
  type YtDlpCommandResult,
  type YtDlpRunCommand,
} from "./yt-dlp";
import type { PlatformHandler, ResolveContext } from "../../platform-handler";
import type {
  DownloadExecutionResult,
  DownloadOptions,
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

type YoutubeHandlerDeps = {
  which: (binary: string) => string | null;
  runCommand: YtDlpRunCommand;
  getVideoResolution: (filePath: string) => Promise<{ width: number; height: number }>;
};

function getPresetArgs(preset: YoutubePreset): string[] {
  switch (preset) {
    case "auto-video-audio":
    case "auto-audio-only":
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
    case "auto-video-audio":
    case "best":
    case "fast-1080":
    case "fast-720":
      return ["--merge-output-format", "mp4"];
    case "auto-audio-only":
      return ["-x", "--audio-format", "mp3"];
    case "best-audio":
      return ["-x", "--audio-format", "mp3"];
    case "mid-audio":
      return ["-x", "--audio-format", "mp3", "--audio-quality", "7"];
  }
}

async function fetchMetadata(
  runCommandImpl: YoutubeHandlerDeps["runCommand"],
  url: string,
): Promise<YoutubeMetadata> {
  const { exitCode, stdout, stderr } = await runCommandImpl(
    buildYtDlpArgs(
      "--no-playlist",
      "--dump-single-json",
      url,
    ),
    {
      timeoutMs: config.get("YT_DLP_YOUTUBE_METADATA_TIMEOUT_MS"),
      timeoutLabel: "yt-dlp youtube metadata fetch",
    },
  );

  if (exitCode !== 0) {
    throw new DownloadError(stderr.trim() || "yt-dlp metadata fetch failed");
  }

  return parseYtDlpMetadata<YoutubeMetadata>(stdout) || {};
}

function requiresMetadataPrefetch(preset: YoutubePreset): boolean {
  return preset === "auto-video-audio" || preset === "auto-audio-only";
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

function buildAutomaticVideoCandidates(
  metadata: YoutubeMetadata,
  maxFileSize?: number,
): Array<DownloadPlan & { score: number }> {
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
        description: `auto video+audio progressive format ${format.format_id}`,
        verboseDetails:
          `auto video+audio: ${format.height || "?"}p ${format.ext || "?"} progressive (${format.format_id})`,
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
        description: `auto video+audio merged formats ${videoFormat.format_id}+${bestAudio.format_id}`,
        verboseDetails:
          `auto video+audio: ${videoFormat.height || "?"}p ${videoFormat.ext || "video"} + ` +
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
  return bestVideo ? [bestVideo] : [];
}

function chooseAutoVideoAudioPlan(
  metadata: YoutubeMetadata,
  maxFileSize?: number,
): DownloadPlan {
  const [bestVideo] = buildAutomaticVideoCandidates(metadata, maxFileSize);
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

  throw new DownloadError(
    buildOversizeMessage({
      estimatedSizeBytes:
        typeof metadata.duration === "number"
          ? estimateVideoSizeFromDuration(metadata.duration)
          : undefined,
      exact: false,
    }),
  );
}

function chooseAutoAudioOnlyPlan(
  metadata: YoutubeMetadata,
  maxFileSize?: number,
): DownloadPlan {
  const formats = metadata.formats || [];
  const duration = metadata.duration;
  const audioFormats = formats
    .filter((format) => !formatHasVideo(format) && formatHasAudio(format))
    .filter((format) => !!format.format_id);

  const audioCandidates = audioFormats
    .map((format) => ({
      kind: "audio" as const,
      formatArgs: ["-f", format.format_id!],
      postprocessArgs: ["-x", "--audio-format", "mp3"],
      estimatedSizeBytes: estimateFormatSizeBytes(format, duration),
      description: `auto audio only format ${format.format_id}`,
      verboseDetails:
        `auto audio only: ${format.abr || format.tbr || "?"}kbps (${format.format_id})`,
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
  if (preset === "auto-video-audio") {
    return chooseAutoVideoAudioPlan(metadata, maxFileSize);
  }

  if (preset === "auto-audio-only") {
    return chooseAutoAudioOnlyPlan(metadata, maxFileSize);
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

export class YoutubePlatformHandler implements PlatformHandler {
  readonly platform = "youtube" as const;

  constructor(
    private readonly deps: YoutubeHandlerDeps = {
      which: (binary) => Bun.which(binary),
      runCommand: runYtDlpCommand,
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

    const preset = context?.youtubePreset || DEFAULT_YOUTUBE_PRESET;
    const tempDir = options?.tempDir || config.get("TEMP_DIR");
    const basename = randomUUIDv7();
    const outputTemplate = path.join(tempDir, `${basename}.%(ext)s`);
    const metadata = requiresMetadataPrefetch(preset)
      ? await fetchMetadata(this.deps.runCommand, url)
      : undefined;
    const plan = buildDownloadPlan(preset, metadata || {}, options?.maxFileSize);
    const estimatedSize = plan.estimatedSizeBytes;
    if (
      options?.maxFileSize !== undefined &&
      ((estimatedSize !== undefined && estimatedSize > options.maxFileSize) ||
        (estimatedSize === undefined &&
          plan.kind === "video" &&
          isLikelyOversizeVideo(metadata?.duration, options.maxFileSize)))
    ) {
      throw new DownloadError(
        buildOversizeMessage({
          estimatedSizeBytes:
            estimatedSize !== undefined
              ? estimatedSize
              : metadata?.duration !== undefined
                ? estimateVideoSizeFromDuration(metadata.duration)
                : undefined,
          exact: estimatedSize !== undefined,
        }),
      );
    }
    logger.debug(
      preset === "best"
        ? "youtube best preset using mp4-first fast path with merge/remux only"
        : preset === "auto-video-audio"
          ? `youtube auto-video-audio preset selected ${plan.description}`
        : preset === "auto-audio-only"
          ? `youtube auto-audio-only preset selected ${plan.description}`
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
    const { exitCode, stdout, stderr } = await this.deps.runCommand(
      buildYtDlpArgs(
        "--no-playlist",
        "--print-json",
        "--progress",
        "--newline",
        "--concurrent-fragments",
        String(config.get("YT_DLP_CONCURRENT_FRAGMENTS")),
        "--output",
        outputTemplate,
        ...plan.formatArgs,
        ...plan.postprocessArgs,
        url,
      ),
      {
        onStdoutLine: async (line) => {
          await emitProgressFromYtDlpLine(line, options?.onProgress);
        },
        onStderrLine: async (line) => {
          await emitProgressFromYtDlpLine(line, options?.onProgress);
        },
        timeoutMs: config.get("YT_DLP_YOUTUBE_DOWNLOAD_TIMEOUT_MS"),
        timeoutLabel: "yt-dlp youtube download",
      },
    );
    logger.debug(`yt-dlp exited with code ${exitCode}`);

    if (exitCode !== 0) {
      logger.debug(`yt-dlp stderr: ${stderr.trim()}`);
      throw new DownloadError(stderr.trim() || "yt-dlp failed");
    }

    const runtimeMetadata = {
      ...(metadata || {}),
      ...(parseYtDlpMetadata<YoutubeMetadata>(stdout) || {}),
    };
    logger.debug(`yt-dlp metadata: ${JSON.stringify(runtimeMetadata)}`);
    const finalPath = resolveYtDlpFinalPath(
      tempDir,
      basename,
      plan.kind === "audio" ? "mp3" : "mp4",
    );
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
                durationSeconds:
                  (typeof runtimeMetadata.duration === "number"
                    ? Math.round(runtimeMetadata.duration)
                    : undefined) ??
                  (await getAudioDuration(finalPath).catch(() => undefined)),
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
    const localVideoMetadata = await getVideoMetadata(finalPath).catch(() => undefined);
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
              resolution: localVideoMetadata
                ? {
                    width: localVideoMetadata.width,
                    height: localVideoMetadata.height,
                  }
                : resolution,
              details: plan.verboseDetails,
              durationSeconds:
                localVideoMetadata?.durationSeconds ??
                (typeof runtimeMetadata.duration === "number"
                  ? Math.round(runtimeMetadata.duration)
                  : undefined),
            },
            cleanup,
          },
        ],
      },
      cleanup,
    };
  }
}
