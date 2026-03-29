import { randomUUIDv7 } from "bun";
import { createWriteStream, mkdirSync } from "fs";
import path from "path";
import { retryAsync } from "src/utils/async";
import { config } from "src/utils/env-validation";
import type { DownloadProgress } from "./types";

const FETCH_INFO_TIMEOUT_MS = 15000;
const FILE_DOWNLOAD_TIMEOUT_MS = 45000;
const FETCH_INFO_RETRIES = 1;
const FILE_DOWNLOAD_RETRIES = 1;
const RETRY_DELAY_MS = 300;

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
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
  async getRemoteContentLength(url: string): Promise<number> {
    return await retryAsync(
      async () => {
        const res = await fetchWithTimeout(url, FETCH_INFO_TIMEOUT_MS, {
          method: "HEAD",
        });
        if (!res.ok) {
          throw new Error(`Failed to get content length: ${res.status}`);
        }

        return parseInt(res.headers.get("Content-Length") || "0");
      },
      {
        retries: FETCH_INFO_RETRIES,
        delayMs: RETRY_DELAY_MS,
        shouldRetry: isRetryableNetworkError,
      },
    );
  }

  async downloadFile(
    url: string,
    dir?: string,
    name?: string,
    onProgress?: (progress: DownloadProgress) => void | Promise<void>,
  ): Promise<string> {
    const resolvedDir = dir || config.get("TEMP_DIR");
    const resolvedName = name || randomUUIDv7();
    const outputPath = path.join(resolvedDir, resolvedName);
    mkdirSync(resolvedDir, { recursive: true });
    await retryAsync(
      async () => {
        const controller = new AbortController();
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const resetTimeout = (phase: string) => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          timeoutId = setTimeout(() => {
            controller.abort(
              new Error(`download timed out during ${phase} after ${FILE_DOWNLOAD_TIMEOUT_MS}ms`),
            );
          }, FILE_DOWNLOAD_TIMEOUT_MS);
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
            : await this.getRemoteContentLength(url).catch(() => 0);
        const reader = res.body.getReader();
        const output = createWriteStream(outputPath, { flags: "w" });
        let downloadedBytes = 0;
        let lastProgressAt = 0;

        try {
          while (true) {
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
              await onProgress?.({
                stage: "download",
                percent:
                  totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : undefined,
                bytesDownloaded: downloadedBytes,
                totalBytes: totalBytes > 0 ? totalBytes : undefined,
              });
            }
          }
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          output.end();
          await new Promise<void>((resolve, reject) => {
            output.once("close", resolve);
            output.once("error", reject);
          });
        }

        await onProgress?.({
          stage: "download",
          percent: totalBytes > 0 ? 100 : undefined,
          bytesDownloaded: downloadedBytes,
          totalBytes: totalBytes > 0 ? totalBytes : undefined,
        });
      },
      {
        retries: FILE_DOWNLOAD_RETRIES,
        delayMs: RETRY_DELAY_MS,
        shouldRetry: isRetryableNetworkError,
      },
    );

    return outputPath;
  }
}
