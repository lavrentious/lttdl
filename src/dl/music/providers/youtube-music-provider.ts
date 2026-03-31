import { randomUUIDv7 } from "bun";
import { existsSync, rmSync } from "fs";
import path from "path";
import { DownloadError } from "src/errors/download-error";
import { formatSizeMegabytes } from "src/dl/size-guard";
import { config } from "src/utils/env-validation";
import { createCenteredSquareJpeg } from "src/utils/image";
import { getAudioDuration, moveFile, writeMp3Metadata } from "src/utils/video";
import {
  buildYtDlpArgs,
  emitProgressFromYtDlpLine,
  parseYtDlpMetadata,
  resolveYtDlpFinalPath,
  runYtDlpCommand,
  YT_DLP_BINARY,
  type YtDlpRunCommand,
} from "src/dl/platforms/youtube/yt-dlp";
import type {
  DownloadExecutionResult,
  DownloadOptions,
} from "src/dl/types";
import type { MusicProvider, MusicSearchResult } from "../provider";

type SearchMetadataEntry = {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  creator?: string;
  duration?: number;
  duration_string?: string;
  artists?: string[];
  webpage_url?: string;
  url?: string;
};

type SearchMetadata = {
  entries?: SearchMetadataEntry[];
};

type DownloadMetadata = {
  title?: string;
  track?: string;
  duration?: number;
  webpage_url?: string;
  artist?: string;
  artists?: string[];
  uploader?: string;
  channel?: string;
  creator?: string;
  creators?: string[];
  album?: string;
  playlist_title?: string;
  thumbnail?: string;
  filesize?: number;
  filesize_approx?: number;
  formats?: DownloadFormat[];
};

type DownloadFormat = {
  format_id?: string;
  ext?: string;
  filesize?: number;
  filesize_approx?: number;
  tbr?: number;
  abr?: number;
  vbr?: number;
  acodec?: string;
  vcodec?: string;
  protocol?: string;
};

type YoutubeMusicProviderDeps = {
  which: (binary: string) => string | null;
  runCommand: YtDlpRunCommand;
  finalizeAudioFile: (
    inputPath: string,
    outputPath: string,
    options: {
      title?: string;
      artist?: string;
      album?: string;
      coverPath?: string;
    },
  ) => Promise<void>;
};

type YoutubeMusicProviderConfig = {
  id: "youtube-music" | "youtube";
  searchMode: "music" | "youtube";
};

const MP3_TARGET_BITRATES_KBPS = [320, 256, 224, 192, 160, 128, 112, 96, 80, 64, 48, 32];
const MP3_V0_ESTIMATED_BITRATE_KBPS = 280;
const MP3_CONTAINER_OVERHEAD_BYTES = 512 * 1024;

function estimateFormatSizeBytes(
  format: DownloadFormat,
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

function getFormatBitrateKbps(format: DownloadFormat): number {
  return Math.max(format.abr || 0, format.tbr || 0, format.vbr || 0);
}

function getEffectiveAudioBitrateKbps(format: DownloadFormat): number {
  if (typeof format.abr === "number" && format.abr > 0) {
    return format.abr;
  }

  if (!formatHasVideo(format)) {
    return Math.max(format.tbr || 0, format.vbr || 0);
  }

  return 0;
}

function getAudioCodecQualityMultiplier(format: DownloadFormat): number {
  if (format.acodec?.includes("opus")) {
    return 1.2;
  }
  if (format.acodec?.includes("mp4a") || format.acodec?.includes("aac")) {
    return 1.0;
  }
  if (format.acodec?.includes("mp3")) {
    return 0.95;
  }
  return 0.9;
}

function formatHasAudio(format: DownloadFormat): boolean {
  return !!format.acodec && format.acodec !== "none";
}

function formatHasVideo(format: DownloadFormat): boolean {
  return !!format.vcodec && format.vcodec !== "none";
}

function formatCompatibilityScore(format: DownloadFormat): number {
  let score = 0;
  if (format.acodec?.includes("opus")) {
    score += 20_000;
  } else if (format.acodec?.includes("mp4a") || format.acodec?.includes("aac")) {
    score += 15_000;
  } else if (format.acodec?.includes("mp3")) {
    score += 12_000;
  }
  if (format.protocol === "https" || format.protocol === "http") {
    score += 2_000;
  }
  if (!formatHasVideo(format)) {
    score += 1_000;
  }
  return score;
}

function buildAudioOversizeMessage(options: {
  estimatedSizeBytes?: number;
  exact?: boolean;
} = {}): string {
  if (
    typeof options.estimatedSizeBytes === "number" &&
    Number.isFinite(options.estimatedSizeBytes)
  ) {
    return options.exact
      ? `audio is too large to upload (${formatSizeMegabytes(options.estimatedSizeBytes)})`
      : `audio is likely too large to upload (about ${formatSizeMegabytes(options.estimatedSizeBytes)})`;
  }

  return options.exact ? "audio is too large to upload" : "audio is likely too large to upload";
}

function estimateMp3SizeBytes(durationSeconds: number, bitrateKbps: number): number {
  return durationSeconds * bitrateKbps * 1000 / 8 + MP3_CONTAINER_OVERHEAD_BYTES;
}

function chooseMp3AudioQuality(
  durationSeconds: number | undefined,
  maxFileSize?: number,
): { value: string; estimatedSizeBytes?: number; exact: boolean } {
  if (!maxFileSize || !durationSeconds || durationSeconds <= 0) {
    return { value: "0", exact: false };
  }

  const v0Estimate = estimateMp3SizeBytes(durationSeconds, MP3_V0_ESTIMATED_BITRATE_KBPS);
  if (v0Estimate <= maxFileSize) {
    return {
      value: "0",
      estimatedSizeBytes: v0Estimate,
      exact: false,
    };
  }

  const bitrate = MP3_TARGET_BITRATES_KBPS.find(
    (candidate) => estimateMp3SizeBytes(durationSeconds, candidate) <= maxFileSize,
  );
  if (!bitrate) {
    throw new DownloadError(
      buildAudioOversizeMessage({
        estimatedSizeBytes: estimateMp3SizeBytes(durationSeconds, MP3_TARGET_BITRATES_KBPS.at(-1)!),
        exact: true,
      }),
    );
  }

  return {
    value: `${bitrate}K`,
    estimatedSizeBytes: estimateMp3SizeBytes(durationSeconds, bitrate),
    exact: true,
  };
}

function chooseAudioDownloadFormat(
  metadata: DownloadMetadata,
  maxFileSize?: number,
): { formatArgs: string[]; estimatedSizeBytes?: number; description: string } {
  const duration = metadata.duration;
  const audioCandidates = (metadata.formats || [])
    .filter((format) => formatHasAudio(format))
    .filter((format) => !!format.format_id)
    .map((format) => ({
      formatId: format.format_id!,
      hasVideo: formatHasVideo(format),
      estimatedSizeBytes: estimateFormatSizeBytes(format, duration),
      effectiveAudioBitrateKbps: getEffectiveAudioBitrateKbps(format),
      audioQualityScore:
        getEffectiveAudioBitrateKbps(format) * getAudioCodecQualityMultiplier(format),
      totalBitrateKbps: getFormatBitrateKbps(format),
      score:
        getEffectiveAudioBitrateKbps(format) *
          getAudioCodecQualityMultiplier(format) *
          1_000_000 +
        getFormatBitrateKbps(format) * 1_000 +
        formatCompatibilityScore(format),
    }))
    .filter(
      (candidate) =>
        maxFileSize === undefined ||
        candidate.estimatedSizeBytes === undefined ||
        candidate.estimatedSizeBytes <= maxFileSize,
    )
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      if (a.hasVideo !== b.hasVideo) {
        return Number(a.hasVideo) - Number(b.hasVideo);
      }

      return (a.estimatedSizeBytes || Number.MAX_SAFE_INTEGER) -
        (b.estimatedSizeBytes || Number.MAX_SAFE_INTEGER);
    });

  const bestCandidate = audioCandidates[0];
  if (bestCandidate) {
    return {
      formatArgs: ["-f", bestCandidate.formatId],
      estimatedSizeBytes: bestCandidate.estimatedSizeBytes,
      description:
        `audio format ${bestCandidate.formatId} ` +
        `(${Math.round(bestCandidate.audioQualityScore || bestCandidate.totalBitrateKbps)}q` +
        `${bestCandidate.hasVideo ? ", progressive" : ", audio only"})`,
    };
  }

  if (maxFileSize !== undefined) {
    const fallbackEstimate =
      typeof metadata.filesize === "number"
        ? metadata.filesize
        : typeof metadata.filesize_approx === "number"
          ? metadata.filesize_approx
          : undefined;
    throw new DownloadError(
      buildAudioOversizeMessage({
        estimatedSizeBytes: fallbackEstimate,
        exact: fallbackEstimate !== undefined,
      }),
    );
  }

  return {
    formatArgs: ["-f", "ba"],
    description: "best available audio format",
  };
}

async function fetchMetadata(
  runCommandImpl: YoutubeMusicProviderDeps["runCommand"],
  url: string,
): Promise<DownloadMetadata> {
  const { exitCode, stdout, stderr } = await runCommandImpl(
    buildYtDlpArgs(
      "--no-playlist",
      "--dump-single-json",
      url,
    ),
    {
      timeoutMs: config.get("YT_DLP_MUSIC_METADATA_TIMEOUT_MS"),
      timeoutLabel: "yt-dlp music metadata fetch",
    },
  );

  if (exitCode !== 0) {
    throw new DownloadError(stderr.trim() || "yt-dlp metadata fetch failed");
  }

  return parseYtDlpMetadata<DownloadMetadata>(stdout) || {};
}

function parseDurationString(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parts = value
    .trim()
    .split(":")
    .map((part) => Number(part));
  if (!parts.length || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return undefined;
  }

  return parts.reduce((total, part) => total * 60 + part, 0);
}

function toWatchUrl(entry: SearchMetadataEntry): string | null {
  if (entry.webpage_url) {
    return entry.webpage_url;
  }

  if (entry.url?.startsWith("http://") || entry.url?.startsWith("https://")) {
    return entry.url;
  }

  if (entry.id) {
    return `https://www.youtube.com/watch?v=${entry.id}`;
  }

  return null;
}

function resolveArtistName(
  metadata: Partial<Pick<SearchMetadataEntry, "artists" | "uploader" | "channel" | "creator">> &
    Partial<
      Pick<
        DownloadMetadata,
        "artist" | "artists" | "uploader" | "channel" | "creator" | "creators"
      >
    >,
): string | undefined {
  const candidates = [
    metadata.artist,
    metadata.artists?.join(", "),
    metadata.creators?.join(", "),
    metadata.uploader,
    metadata.channel,
    metadata.creator,
  ];

  return candidates.find((value) => typeof value === "string" && value.trim())?.trim();
}

function resolveAlbumName(metadata: DownloadMetadata): string | undefined {
  const candidates = [metadata.album, metadata.playlist_title, metadata.channel];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim();
}

function ensureMp3Filename(name: string | undefined): string {
  const base = (name?.trim() || "audio").replace(/[\\/:*?\"<>|]/g, "_").trim() || "audio";
  return base.toLowerCase().endsWith(".mp3") ? base : `${base}.mp3`;
}

async function createSquareThumbnail(
  thumbnailUrl: string | undefined,
  outputPath: string,
): Promise<string | undefined> {
  if (!thumbnailUrl) {
    return undefined;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    config.get("YT_DLP_THUMBNAIL_FETCH_TIMEOUT_MS"),
  );
  const response = await fetch(thumbnailUrl, {
    signal: controller.signal,
  }).catch(() => undefined);
  clearTimeout(timeoutId);
  if (!response?.ok) {
    return undefined;
  }

  const body = await response.arrayBuffer().catch(() => undefined);
  if (!body) {
    return undefined;
  }

  await createCenteredSquareJpeg(body, outputPath).catch(() => undefined);
  return existsSync(outputPath) ? outputPath : undefined;
}

function normalizeSearchResults(metadata: SearchMetadata): MusicSearchResult[] {
  const results: MusicSearchResult[] = [];

  for (const entry of metadata.entries || []) {
    const url = toWatchUrl(entry);
    if (!entry.id || !entry.title || !url) {
      continue;
    }

    results.push({
      id: entry.id,
      url,
      title: entry.title,
      uploader: resolveArtistName(entry),
      durationSeconds:
        typeof entry.duration === "number"
          ? Math.round(entry.duration)
          : parseDurationString(entry.duration_string),
    });
  }

  return results;
}

export class YoutubeMusicProvider implements MusicProvider {
  constructor(
    private readonly provider: YoutubeMusicProviderConfig,
    private readonly deps: YoutubeMusicProviderDeps = {
      which: (binary) => Bun.which(binary),
      runCommand: runYtDlpCommand,
      finalizeAudioFile: writeMp3Metadata,
    },
  ) {}

  get id() {
    return this.provider.id;
  }

  async search(query: string, limit: number): Promise<MusicSearchResult[]> {
    if (!this.deps.which(YT_DLP_BINARY)) {
      throw new DownloadError("yt-dlp is not installed");
    }

    const searchInput =
      this.provider.searchMode === "music"
        ? `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`
        : `ytsearch${limit}:${query}`;
    const command = buildYtDlpArgs(
      "--dump-single-json",
      ...(this.provider.searchMode === "youtube" ? ["--flat-playlist"] : []),
      ...(this.provider.searchMode === "music" ? ["--playlist-items", `1:${limit}`] : []),
      searchInput,
    );
    const { exitCode, stdout, stderr } = await this.deps.runCommand(command, {
      timeoutMs: config.get("YT_DLP_MUSIC_SEARCH_TIMEOUT_MS"),
      timeoutLabel: "yt-dlp music search",
    });

    if (exitCode !== 0) {
      throw new DownloadError(stderr.trim() || "yt-dlp music search failed");
    }

    const metadata = parseYtDlpMetadata<SearchMetadata>(stdout);
    const results = normalizeSearchResults(metadata || {});
    if (!results.length) {
      throw new DownloadError("no music results found");
    }

    return results;
  }

  async download(
    result: MusicSearchResult,
    options?: DownloadOptions,
  ): Promise<DownloadExecutionResult> {
    if (!this.deps.which(YT_DLP_BINARY)) {
      throw new DownloadError("yt-dlp is not installed");
    }

    const tempDir = options?.tempDir || config.get("TEMP_DIR");
    const basename = randomUUIDv7();
    const outputTemplate = path.join(tempDir, `${basename}.%(ext)s`);
    const prefetchMetadata = await fetchMetadata(this.deps.runCommand, result.url).catch(
      () => ({} as DownloadMetadata),
    );
    const audioPlan = chooseAudioDownloadFormat(prefetchMetadata, options?.maxFileSize);
    const mp3Quality = chooseMp3AudioQuality(prefetchMetadata.duration, options?.maxFileSize);
    const { exitCode, stdout, stderr } = await this.deps.runCommand(
      buildYtDlpArgs(
        ...audioPlan.formatArgs,
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        mp3Quality.value,
        "--concurrent-fragments",
        String(config.get("YT_DLP_CONCURRENT_FRAGMENTS")),
        "--add-metadata",
        "--embed-thumbnail",
        "--output",
        outputTemplate,
        result.url,
      ),
      {
        onStdoutLine: async (line) => {
          await emitProgressFromYtDlpLine(line, options?.onProgress);
        },
        onStderrLine: async (line) => {
          await emitProgressFromYtDlpLine(line, options?.onProgress);
        },
        timeoutMs: config.get("YT_DLP_MUSIC_DOWNLOAD_TIMEOUT_MS"),
        timeoutLabel: "yt-dlp music download",
      },
    );

    if (exitCode !== 0) {
      throw new DownloadError(stderr.trim() || "yt-dlp failed");
    }

    const metadata = {
      ...prefetchMetadata,
      ...(parseYtDlpMetadata<DownloadMetadata>(stdout) || {}),
    };
    const finalPath = resolveYtDlpFinalPath(tempDir, basename, "mp3");
    const thumbnailPath = await createSquareThumbnail(
      metadata.thumbnail,
      path.join(tempDir, `${basename}.jpg`),
    );
    const trackName = metadata.track || metadata.title || result.title;
    const performer = resolveArtistName(metadata) || result.uploader;
    const album = resolveAlbumName(metadata);
    const taggedPath = path.join(tempDir, `${basename}.tagged.mp3`);
    await this.deps.finalizeAudioFile(finalPath, taggedPath, {
      title: trackName,
      artist: performer,
      album,
      coverPath: thumbnailPath,
    });
    moveFile(taggedPath, finalPath);
    await options?.onProgress?.({
      stage: "completed",
      message: "download complete",
    });

    const cleanup = () => {
      if (existsSync(finalPath)) {
        rmSync(finalPath);
      }
      if (thumbnailPath && existsSync(thumbnailPath)) {
        rmSync(thumbnailPath);
      }
    };

    return {
      res: {
        contentType: "music",
        variants: [
          {
            downloaded: true,
            downloadUrl: metadata.webpage_url || result.url,
            path: finalPath,
            size: Bun.file(finalPath).size,
            payload: {
              name: trackName,
              filename: ensureMp3Filename(trackName),
              performer,
              details: album,
              thumbnailPath,
              durationSeconds:
                (typeof metadata.duration === "number"
                  ? Math.round(metadata.duration)
                  : undefined) ??
                result.durationSeconds ??
                (await getAudioDuration(finalPath).catch(() => undefined)),
            },
            cleanup,
          },
        ],
      },
      cleanup,
    };
  }
}
