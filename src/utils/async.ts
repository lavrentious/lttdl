export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (concurrency < 1) {
    throw new Error("concurrency must be at least 1");
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
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
  }: {
    retries: number;
    delayMs?: number;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
  },
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt > retries || !shouldRetry(error, attempt)) {
        throw error;
      }

      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: Timer | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
