import { existsSync, readdirSync } from "fs";
import path from "path";
import { DownloadError } from "src/errors/download-error";
import { logger } from "src/utils/logger";
import type { DownloadProgress } from "src/dl/types";

export const YT_DLP_BINARY = "yt-dlp";
export const YT_DLP_COMMON_ARGS = ["--js-runtimes", "bun"] as const;

export type YtDlpCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type YtDlpCommandHooks = {
  onStdoutLine?: (line: string) => void | Promise<void>;
  onStderrLine?: (line: string) => void | Promise<void>;
  timeoutMs?: number;
  timeoutLabel?: string;
};

export type YtDlpRunCommand = (
  cmd: string[],
  hooks?: YtDlpCommandHooks,
) => Promise<YtDlpCommandResult>;

function normalizePostprocessMessage(line: string): string | null {
  const message = line.replace(/^\[[^\]]+\]\s*/, "").trim();
  if (!message) {
    return null;
  }

  if (/^Destination:/i.test(message)) {
    return null;
  }

  if (/^Deleting original file /i.test(message)) {
    return null;
  }

  if (/^Correcting container in /i.test(message)) {
    return "finalizing container...";
  }

  if (/^Merging formats into /i.test(message)) {
    return "merging media streams...";
  }

  if (/^Remuxing video from /i.test(message)) {
    return "remuxing video...";
  }

  if (/^(Adding|Embedding) metadata to /i.test(message)) {
    return "embedding metadata...";
  }

  if (/^(Adding|Embedding) thumbnail to /i.test(message)) {
    return "embedding thumbnail...";
  }

  if (/^Extracting audio/i.test(message)) {
    return "extracting audio...";
  }

  return message;
}

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

export async function runYtDlpCommand(
  cmd: string[],
  hooks: YtDlpCommandHooks = {},
): Promise<YtDlpCommandResult> {
  logger.debug(`running yt-dlp command: ${cmd.join(" ")}`);
  const process = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const execution = Promise.all([
    process.exited,
    readStream(process.stdout, hooks.onStdoutLine),
    readStream(process.stderr, hooks.onStderrLine),
  ]);

  let timeoutId: Timer | null = null;
  const timedExecution =
    typeof hooks.timeoutMs === "number" && hooks.timeoutMs > 0
      ? Promise.race([
          execution,
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              try {
                process.kill();
              } catch {}

              reject(
                new Error(
                  `${hooks.timeoutLabel || "yt-dlp command"} timed out after ${hooks.timeoutMs}ms`,
                ),
              );
            }, hooks.timeoutMs);
          }),
        ])
      : execution;

  try {
    const [exitCode, stdout, stderr] = await timedExecution;

    return {
      exitCode,
      stdout,
      stderr,
    };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function parseYtDlpMetadata<T>(stdout: string): T | null {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate = lines.at(-1);

  if (!candidate) {
    return null;
  }

  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
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
    const message = normalizePostprocessMessage(line);
    if (!message) {
      return null;
    }

    return {
      stage: "postprocess",
      message,
    };
  }

  return null;
}

export async function emitProgressFromYtDlpLine(
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

export function resolveYtDlpFinalPath(
  tempDir: string,
  basename: string,
  expectedExtension?: string,
): string {
  if (expectedExtension) {
    const expectedPath = path.join(tempDir, `${basename}.${expectedExtension}`);
    if (existsSync(expectedPath)) {
      logger.debug(`resolved yt-dlp output path: ${expectedPath}`);
      return expectedPath;
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
