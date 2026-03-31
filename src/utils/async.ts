import { DownloadError, OperationCancelledError } from "src/errors/download-error";

export function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) {
    return;
  }

  throw signal.reason instanceof Error
    ? signal.reason
    : new OperationCancelledError("operation cancelled");
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  options: {
    signal?: AbortSignal;
  } = {},
): Promise<R[]> {
  if (concurrency < 1) {
    throw new Error("concurrency must be at least 1");
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      throwIfAborted(options.signal);
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex]!, currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return results;
}

export async function retryAsync<T>(
  operation: (attempt: number) => Promise<T>,
  {
    retries,
    delayMs = 0,
    shouldRetry = () => false,
    signal,
  }: {
    retries: number;
    delayMs?: number;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    signal?: AbortSignal;
  },
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    throwIfAborted(signal);
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt > retries || !shouldRetry(error, attempt)) {
        throw error;
      }

      if (delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, delayMs);
          const onAbort = () => {
            clearTimeout(timeoutId);
            signal?.removeEventListener("abort", onAbort);
            reject(
              signal?.reason instanceof Error
                ? signal.reason
                : new OperationCancelledError("operation cancelled"),
            );
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
  }

  throw lastError;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  let timeoutId: Timer | null = null;
  let abortHandler: (() => void) | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new DownloadError("timeout exceeded"));
    }, timeoutMs);
  });

  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        abortHandler = () => {
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new OperationCancelledError("operation cancelled"),
          );
        };
        signal.addEventListener("abort", abortHandler, { once: true });
      })
    : null;

  try {
    return await Promise.race([promise, timeoutPromise, ...(abortPromise ? [abortPromise] : [])]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}
