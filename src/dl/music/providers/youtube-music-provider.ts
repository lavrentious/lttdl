import { randomUUIDv7 } from "bun";
import { existsSync, rmSync } from "fs";
import path from "path";
import { DownloadError } from "src/errors/download-error";
import { config } from "src/utils/env-validation";
import { getAudioDuration } from "src/utils/video";
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
  duration?: number;
  webpage_url?: string;
};

type YoutubeMusicProviderDeps = {
  which: (binary: string) => string | null;
  runCommand: YtDlpRunCommand;
};

type YoutubeMusicProviderConfig = {
  id: "youtube-music" | "youtube";
  searchMode: "music" | "youtube";
};

const YT_DLP_CONCURRENT_FRAGMENTS = "4";

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
      uploader: entry.artists?.join(", ") || entry.uploader || entry.channel,
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

    const metadata = parseYtDlpMetadata<DownloadMetadata>(stdout) || {};
    const finalPath = resolveYtDlpFinalPath(tempDir, basename, "mp3");
    await options?.onProgress?.({
      stage: "completed",
      message: "download complete",
    });

    const cleanup = () => {
      if (existsSync(finalPath)) {
        rmSync(finalPath);
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
              name: metadata.title || result.title,
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
