export class DownloadError extends Error {}

export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}

export function toDownloadError(
  error: unknown,
  fallbackMessage = "internal error",
): DownloadError {
  if (error instanceof DownloadError) {
    return error;
  }

  if (isTimeoutError(error)) {
    return new DownloadError("timeout exceeded");
  }

  return new DownloadError(fallbackMessage);
}
