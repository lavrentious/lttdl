import { randomUUIDv7 } from "bun";
import { existsSync, rmSync } from "fs";
import path from "path";
import { DownloadError } from "src/errors/download-error";
import { config } from "src/utils/env-validation";
import { logger } from "src/utils/logger";
import { getVideoResolution } from "src/utils/video";
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
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type YoutubeHandlerDeps = {
  which: (binary: string) => string | null;
  runCommand: (cmd: string[]) => Promise<CommandResult>;
  getVideoResolution: (filePath: string) => Promise<{ width: number; height: number }>;
};

const YT_DLP_BINARY = "yt-dlp";

async function runCommand(cmd: string[]): Promise<CommandResult> {
  logger.debug(`running yt-dlp command: ${cmd.join(" ")}`);
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

function getPresetArgs(preset: YoutubePreset): string[] {
  switch (preset) {
    case "best":
      return ["-f", "bv*+ba", "--recode-video", "mp4"];
    case "best-audio":
      return ["-f", "ba", "-x", "--audio-format", "mp3"];
  }
}

function getExpectedExtension(preset: YoutubePreset): "mp4" | "mp3" {
  return preset === "best" ? "mp4" : "mp3";
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

function resolveFinalPath(
  tempDir: string,
  basename: string,
  preset: YoutubePreset,
): string {
  const expectedPath = path.join(tempDir, `${basename}.${getExpectedExtension(preset)}`);
  if (existsSync(expectedPath)) {
    logger.debug(`resolved yt-dlp output path: ${expectedPath}`);
    return expectedPath;
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
    logger.debug(
      `youtube preset=${preset}, tempDir=${tempDir}, outputTemplate=${outputTemplate}`,
    );
    const { exitCode, stdout, stderr } = await this.deps.runCommand([
      YT_DLP_BINARY,
      "--no-playlist",
      "--print-json",
      "--no-progress",
      "--output",
      outputTemplate,
      ...getPresetArgs(preset),
      url,
    ]);
    logger.debug(`yt-dlp exited with code ${exitCode}`);

    if (exitCode !== 0) {
      logger.debug(`yt-dlp stderr: ${stderr.trim()}`);
      throw new DownloadError(stderr.trim() || "yt-dlp failed");
    }

    const metadata = parseMetadata(stdout);
    logger.debug(`yt-dlp metadata: ${JSON.stringify(metadata)}`);
    const finalPath = resolveFinalPath(tempDir, basename, preset);
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
              downloadUrl: metadata.webpage_url || url,
              path: finalPath,
              size: Bun.file(finalPath).size,
              payload: {
                name: metadata.title,
              },
              cleanup,
            },
          ],
        },
        cleanup,
      };
    }

    const resolution =
      typeof metadata.width === "number" && typeof metadata.height === "number"
        ? { width: metadata.width, height: metadata.height }
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
            downloadUrl: metadata.webpage_url || url,
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
