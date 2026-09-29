import { randomUUIDv7 } from "bun";
import { readdirSync } from "fs";
import path from "path";
import { buildOversizeMessage } from "src/dl/size-guard";
import { DownloadError } from "src/errors/download-error";
import { config } from "src/utils/env-validation";
import { getVideoMetadata } from "src/utils/video";
import type { PlatformHandler } from "../../platform-handler";
import type {
  DownloadExecutionResult,
  DownloadOptions,
  VideoVariant,
} from "../../types";
import {
  buildYtDlpArgs,
  cleanupYtDlpArtifacts,
  emitProgressFromYtDlpLine,
  runYtDlpCommand,
  YT_DLP_BINARY,
  type YtDlpRunCommand,
} from "../youtube/yt-dlp";

const X_HOSTNAME = /^(?:(?:www|m|mobile)\.)?(?:x|twitter)\.com$/;

type XHandlerDeps = {
  which: (binary: string) => string | null;
  runCommand: YtDlpRunCommand;
  getVideoMetadata: typeof getVideoMetadata;
};

// ponytail: videos/gifs only (yt-dlp skips photos), add gallery-dl if photo posts matter
export class XPlatformHandler implements PlatformHandler {
  readonly platform = "x" as const;

  constructor(
    private readonly deps: XHandlerDeps = {
      which: (binary) => Bun.which(binary),
      runCommand: runYtDlpCommand,
      getVideoMetadata,
    },
  ) {}

  canHandle(url: string): boolean {
    try {
      return X_HOSTNAME.test(new URL(url).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  async download(
    url: string,
    _context = {},
    options?: DownloadOptions,
  ): Promise<DownloadExecutionResult> {
    if (!this.deps.which(YT_DLP_BINARY)) {
      throw new DownloadError("yt-dlp is not installed");
    }

    const tempDir = options?.tempDir || config.get("TEMP_DIR");
    const basename = randomUUIDv7();
    const maxFileSize = options?.maxFileSize;
    const cleanup = () => cleanupYtDlpArtifacts(tempDir, basename);

    try {
      // .../video/N -> that video only (--no-playlist); bare status url -> every video in the post
      const { exitCode, stderr } = await this.deps.runCommand(
        buildYtDlpArgs([
          "--no-playlist",
          "--progress",
          "--newline",
          "--output",
          path.join(tempDir, `${basename}.%(autonumber)s.%(ext)s`),
          "-f",
          maxFileSize
            ? `b[filesize_approx<=?${maxFileSize}]/b/bv*+ba`
            : "b/bv*+ba",
          "--merge-output-format",
          "mp4",
          ...(maxFileSize ? ["--max-filesize", String(maxFileSize)] : []),
          url,
        ]),
        {
          onStdoutLine: (line) =>
            emitProgressFromYtDlpLine(line, options?.onProgress),
          onStderrLine: (line) =>
            emitProgressFromYtDlpLine(line, options?.onProgress),
          timeoutMs: config.get("YT_DLP_YOUTUBE_DOWNLOAD_TIMEOUT_MS"),
          timeoutLabel: "yt-dlp x download",
          signal: options?.signal,
        },
      );
      if (exitCode !== 0) {
        throw new DownloadError(stderr.trim() || "yt-dlp failed");
      }

      const files = readdirSync(tempDir)
        .filter(
          (entry) =>
            entry.startsWith(`${basename}.`) && !entry.endsWith(".part"),
        )
        .sort()
        .map((entry) => path.join(tempDir, entry));
      if (!files.length) {
        // yt-dlp exits 0 without a file when --max-filesize aborts
        throw new DownloadError(
          maxFileSize
            ? buildOversizeMessage()
            : "yt-dlp completed but produced no output file",
        );
      }

      const variants = await Promise.all(
        files.map(async (filePath): Promise<VideoVariant> => {
          const { width, height, durationSeconds } =
            await this.deps.getVideoMetadata(filePath);
          return {
            downloaded: true,
            downloadUrl: url,
            path: filePath,
            size: Bun.file(filePath).size,
            payload: { resolution: { width, height }, durationSeconds },
            cleanup,
          };
        }),
      );

      await options?.onProgress?.({
        stage: "completed",
        message: "download complete",
      });
      return {
        res:
          variants.length === 1
            ? { contentType: "video", variants }
            : {
                contentType: "gallery",
                entries: variants.map((variant) => ({
                  kind: "video",
                  variants: [variant],
                })),
              },
        cleanup,
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  }
}
