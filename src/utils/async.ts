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
