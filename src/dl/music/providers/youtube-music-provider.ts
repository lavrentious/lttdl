import { randomUUIDv7 } from "bun";
import { existsSync, rmSync } from "fs";
import path from "path";
import { DownloadError } from "src/errors/download-error";
import { config } from "src/utils/env-validation";
import { createCenteredSquareJpeg } from "src/utils/image";
import { getAudioDuration, moveFile, writeMp3Metadata } from "src/utils/video";
import {
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

const YT_DLP_CONCURRENT_FRAGMENTS = "4";

async function fetchMetadata(
  runCommandImpl: YoutubeMusicProviderDeps["runCommand"],
  url: string,
): Promise<DownloadMetadata> {
  const { exitCode, stdout, stderr } = await runCommandImpl([
    YT_DLP_BINARY,
    "--no-playlist",
    "--dump-single-json",
    url,
  ]);

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

  const response = await fetch(thumbnailUrl).catch(() => undefined);
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
    const command = [
      YT_DLP_BINARY,
      "--dump-single-json",
      ...(this.provider.searchMode === "youtube" ? ["--flat-playlist"] : []),
      ...(this.provider.searchMode === "music" ? ["--playlist-items", `1:${limit}`] : []),
      searchInput,
    ];
    const { exitCode, stdout, stderr } = await this.deps.runCommand(command);

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
      () => ({}),
    );
    const { exitCode, stdout, stderr } = await this.deps.runCommand(
      [
        YT_DLP_BINARY,
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
        "--concurrent-fragments",
        YT_DLP_CONCURRENT_FRAGMENTS,
        "--add-metadata",
        "--embed-thumbnail",
        "--output",
        outputTemplate,
        result.url,
      ],
      {
        onStdoutLine: async (line) => {
          await emitProgressFromYtDlpLine(line, options?.onProgress);
        },
        onStderrLine: async (line) => {
          await emitProgressFromYtDlpLine(line, options?.onProgress);
        },
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
