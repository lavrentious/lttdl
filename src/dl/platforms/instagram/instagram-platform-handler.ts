import { randomUUIDv7 } from "bun";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  DownloadError,
  OperationCancelledError,
} from "src/errors/download-error";
import { getImageResolution } from "src/utils/image";
import { config } from "src/utils/env-validation";
import { logger } from "src/utils/logger";
import { throwIfAborted } from "src/utils/async";
import { getVideoMetadata } from "src/utils/video";
import type { PlatformHandler } from "../../platform-handler";
import type {
  DownloadExecutionResult,
  DownloadOptions,
  DownloadProgress,
  GalleryEntry,
  PhotoVariant,
  VideoVariant,
} from "../../types";

const INSTALOADER_BINARY = "instaloader";
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type InstagramHandlerDeps = {
  which: (binary: string) => string | null;
  runCommand: (
    cmd: string[],
    workdir: string,
    onProgress?: (progress: DownloadProgress) => void | Promise<void>,
    signal?: AbortSignal,
  ) => Promise<CommandResult>;
  getImageResolution: (filePath: string) => Promise<{ width: number; height: number }>;
  getVideoMetadata: (filePath: string) => Promise<{
    width: number;
    height: number;
    durationSeconds?: number;
  }>;
};

async function runCommand(
  cmd: string[],
  workdir: string,
  onProgress?: (progress: DownloadProgress) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<CommandResult> {
  logger.debug(`running instaloader command: ${cmd.join(" ")}`);
  await onProgress?.({
    stage: "status",
    message: "downloading instagram media...",
  });
  const process = Bun.spawn({
    cmd,
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  let abortHandler: (() => void) | null = null;
  const execution = Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        abortHandler = () => {
          try {
            process.kill();
          } catch {}
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new OperationCancelledError("operation cancelled"),
          );
        };
        signal.addEventListener("abort", abortHandler, { once: true });
      })
    : null;

  const [exitCode, stdout, stderr] = await (abortPromise
    ? Promise.race([execution, abortPromise])
    : execution);

  if (signal && abortHandler) {
    signal.removeEventListener("abort", abortHandler);
  }

  return { exitCode, stdout, stderr };
}

export function extractInstagramShortcode(url: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new DownloadError("invalid instagram link");
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (
    hostname !== "instagram.com" &&
    hostname !== "www.instagram.com" &&
    hostname !== "instagr.am" &&
    hostname !== "www.instagr.am"
  ) {
    throw new DownloadError("unsupported instagram link");
  }

  const segments = parsedUrl.pathname.split("/").filter(Boolean);
  const section = segments[0]?.toLowerCase();
  const shortcode = segments[1];

  if (
    (section !== "p" && section !== "reel" && section !== "reels") ||
    !shortcode ||
    !/^[A-Za-z0-9_-]+$/.test(shortcode)
  ) {
    throw new DownloadError("unsupported instagram link");
  }

  return shortcode;
}

function classifyPath(filePath: string): "image" | "video" | null {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  return null;
}

function listDownloadedMediaFiles(workdir: string): string[] {
  return readdirSync(workdir)
    .map((entry) => path.join(workdir, entry))
    .filter((entryPath) => existsSync(entryPath))
    .filter((entryPath) => {
      const name = path.basename(entryPath);
      if (name.startsWith(".")) {
        return false;
      }
      return classifyPath(entryPath) !== null;
    })
    .sort((a, b) => a.localeCompare(b));
}

export class InstagramPlatformHandler implements PlatformHandler {
  readonly platform = "instagram" as const;

  constructor(
    private readonly deps: InstagramHandlerDeps = {
      which: (binary) => Bun.which(binary),
      runCommand,
      getImageResolution,
      getVideoMetadata,
    },
  ) {}

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return (
        hostname === "instagram.com" ||
        hostname === "www.instagram.com" ||
        hostname === "instagr.am" ||
        hostname === "www.instagr.am"
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
    if (!this.deps.which(INSTALOADER_BINARY)) {
      throw new DownloadError("instaloader is not installed");
    }

    const shortcode = extractInstagramShortcode(url);
    const tempDir = options?.tempDir || config.get("TEMP_DIR");
    const workdir = path.join(tempDir, `instagram-${shortcode}-${randomUUIDv7()}`);
    mkdirSync(workdir, { recursive: true });

    await options?.onProgress?.({
      stage: "status",
      message: "resolving instagram media...",
    });
    throwIfAborted(options?.signal);

    const { exitCode, stderr } = await this.deps.runCommand(
      [
        INSTALOADER_BINARY,
        "--no-metadata-json",
        "--no-captions",
        "--no-video-thumbnails",
        "--dirname-pattern",
        ".",
        "--filename-pattern",
        "lttdl_",
        "--",
        `-${shortcode}`,
      ],
      workdir,
      options?.onProgress,
      options?.signal,
    );

    if (exitCode !== 0) {
      throw new DownloadError(stderr.trim() || "instaloader failed");
    }

    const files = listDownloadedMediaFiles(workdir);
    if (!files.length) {
      throw new DownloadError("instaloader returned no media files");
    }

    const entries: GalleryEntry[] = [];
    for (const filePath of files) {
      throwIfAborted(options?.signal);
      const kind = classifyPath(filePath);
      if (kind === "image") {
        const resolution = await this.deps.getImageResolution(filePath);
        entries.push({
          kind: "image",
          variants: [
            {
              downloaded: true,
              downloadUrl: url,
              path: filePath,
              size: Bun.file(filePath).size,
              payload: { resolution },
            } satisfies PhotoVariant,
          ],
        });
      } else if (kind === "video") {
        const metadata = await this.deps.getVideoMetadata(filePath);
        entries.push({
          kind: "video",
          variants: [
            {
              downloaded: true,
              downloadUrl: url,
              path: filePath,
              size: Bun.file(filePath).size,
              payload: {
                resolution: {
                  width: metadata.width,
                  height: metadata.height,
                },
                durationSeconds: metadata.durationSeconds,
              },
            } satisfies VideoVariant,
          ],
        });
      }
    }

    if (!entries.length) {
      throw new DownloadError("instaloader returned no supported media");
    }

    await options?.onProgress?.({
      stage: "completed",
      message: "instagram download complete",
    });

    const cleanup = () => {
      rmSync(workdir, { recursive: true, force: true });
    };

    if (entries.length === 1) {
      const [entry] = entries;
      if (!entry) {
        throw new DownloadError("instaloader returned no supported media");
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

    return {
      res: {
        contentType: "gallery",
        entries,
      },
      cleanup,
    };
  }
}
