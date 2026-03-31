import { randomUUIDv7 } from "bun";
import { createWriteStream, existsSync, mkdirSync, rmSync } from "fs";
import { OperationCancelledError } from "src/errors/download-error";
import path from "path";
import { retryAsync, throwIfAborted } from "src/utils/async";
import { config } from "src/utils/env-validation";
import type { DownloadProgress } from "./types";

function formatBytesPerSecond(bytesPerSecond: number): string | undefined {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return undefined;
  }

  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = bytesPerSecond;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatEta(totalSeconds: number): string | undefined {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return undefined;
  }

  const seconds = Math.ceil(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }

  return `${secs}s`;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort(
      signal?.reason instanceof Error
        ? signal.reason
        : new OperationCancelledError("operation cancelled"),
    );
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`fetch timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("socket") ||
    message.includes("connection")
  );
}

export class AssetDownloader {
  async getRemoteContentLength(url: string, signal?: AbortSignal): Promise<number> {
    const fetchInfoTimeoutMs = config.get("NETWORK_FETCH_INFO_TIMEOUT_MS");
    const fetchInfoRetries = config.get("NETWORK_FETCH_INFO_RETRIES");
    const retryDelayMs = config.get("NETWORK_RETRY_DELAY_MS");
    return await retryAsync(
      async () => {
        throwIfAborted(signal);
        const res = await fetchWithTimeout(url, fetchInfoTimeoutMs, signal, {
          method: "HEAD",
        });
        if (!res.ok) {
          throw new Error(`Failed to get content length: ${res.status}`);
        }

        return parseInt(res.headers.get("Content-Length") || "0");
      },
      {
        retries: fetchInfoRetries,
        delayMs: retryDelayMs,
        shouldRetry: isRetryableNetworkError,
        signal,
      },
    );
  }

  async downloadFile(
    url: string,
    dir?: string,
    name?: string,
    onProgress?: (progress: DownloadProgress) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<string> {
    const resolvedDir = dir || config.get("TEMP_DIR");
    const resolvedName = name || randomUUIDv7();
    const outputPath = path.join(resolvedDir, resolvedName);
    const fileDownloadTimeoutMs = config.get("ASSET_FILE_DOWNLOAD_TIMEOUT_MS");
    const fileDownloadRetries = config.get("ASSET_FILE_DOWNLOAD_RETRIES");
    const retryDelayMs = config.get("NETWORK_RETRY_DELAY_MS");
    mkdirSync(resolvedDir, { recursive: true });
    await retryAsync(
      async () => {
        throwIfAborted(signal);
        const controller = new AbortController();
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const onAbort = () => {
          controller.abort(
            signal?.reason instanceof Error
              ? signal.reason
              : new OperationCancelledError("operation cancelled"),
          );
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const resetTimeout = (phase: string) => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          timeoutId = setTimeout(() => {
            controller.abort(
              new Error(`download timed out during ${phase} after ${fileDownloadTimeoutMs}ms`),
            );
          }, fileDownloadTimeoutMs);
        };

        resetTimeout("request");
        const res = await fetch(url, {
          signal: controller.signal,
        });
        if (!res.ok) {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          throw new Error(`Failed to download: ${res.status}`);
        }
        if (!res.body) {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          throw new Error("download response has no body");
        }

        const totalBytesFromGet = parseInt(
          res.headers.get("Content-Length") || "0",
        );
        const totalBytes =
          totalBytesFromGet > 0
            ? totalBytesFromGet
            : await this.getRemoteContentLength(url, signal).catch(() => 0);
        const reader = res.body.getReader();
        const output = createWriteStream(outputPath, { flags: "w" });
        let downloadedBytes = 0;
        let lastProgressAt = 0;
        const startedAt = Date.now();

        try {
          while (true) {
            throwIfAborted(signal);
            resetTimeout("response stream");
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            if (!value) {
              continue;
            }

            downloadedBytes += value.byteLength;
            if (!output.write(Buffer.from(value))) {
              resetTimeout("file write");
              await new Promise<void>((resolve) =>
                output.once("drain", resolve),
              );
            }

            const now = Date.now();
            if (now - lastProgressAt >= 500) {
              lastProgressAt = now;
              const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
              const bytesPerSecond = downloadedBytes / elapsedSeconds;
              await onProgress?.({
                stage: "download",
                percent:
                  totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : undefined,
                bytesDownloaded: downloadedBytes,
                totalBytes: totalBytes > 0 ? totalBytes : undefined,
                speed: formatBytesPerSecond(bytesPerSecond),
                eta:
                  totalBytes > 0
                    ? formatEta((totalBytes - downloadedBytes) / bytesPerSecond)
                    : undefined,
              });
            }
          }
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          signal?.removeEventListener("abort", onAbort);
          output.end();
          await new Promise<void>((resolve, reject) => {
            output.once("close", resolve);
            output.once("error", reject);
          });
        }

        const totalElapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
        const averageBytesPerSecond = downloadedBytes / totalElapsedSeconds;
        await onProgress?.({
          stage: "download",
          percent: totalBytes > 0 ? 100 : undefined,
          bytesDownloaded: downloadedBytes,
          totalBytes: totalBytes > 0 ? totalBytes : undefined,
          speed: formatBytesPerSecond(averageBytesPerSecond),
          eta: totalBytes > 0 ? "0s" : undefined,
        });
      },
      {
        retries: fileDownloadRetries,
        delayMs: retryDelayMs,
        shouldRetry: isRetryableNetworkError,
        signal,
      },
    ).catch((error) => {
      if (existsSync(outputPath)) {
        rmSync(outputPath, { force: true });
      }
      throw error;
    });

    return outputPath;
  }
}
