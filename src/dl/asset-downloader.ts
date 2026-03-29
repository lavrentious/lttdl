import { randomUUIDv7 } from "bun";
import path from "path";
import { config } from "src/utils/env-validation";
import { retryAsync } from "src/utils/async";

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

  async downloadFile(url: string, dir?: string, name?: string): Promise<string> {
    const resolvedDir = dir || config.get("TEMP_DIR");
    const resolvedName = name || randomUUIDv7();
    const outputPath = path.join(resolvedDir, resolvedName);
    const arrayBuffer = await retryAsync(
      async () => {
        const res = await fetchWithTimeout(url, FILE_DOWNLOAD_TIMEOUT_MS);
        if (!res.ok) {
          throw new Error(`Failed to download: ${res.status}`);
        }

        return await res.arrayBuffer();
      },
      {
        retries: FILE_DOWNLOAD_RETRIES,
        delayMs: RETRY_DELAY_MS,
        shouldRetry: isRetryableNetworkError,
      },
    );
    await Bun.write(outputPath, arrayBuffer, { createPath: true });

    return outputPath;
  }
}
