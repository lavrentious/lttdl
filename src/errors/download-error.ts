export class DownloadError extends Error {}
export class OperationCancelledError extends DownloadError {}

export function isCancelledError(error: unknown): boolean {
  if (error instanceof OperationCancelledError) {
    return true;
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as { message?: unknown; name?: unknown };
  const message =
    typeof maybeError.message === "string"
      ? maybeError.message.toLowerCase()
      : "";
  const name =
    typeof maybeError.name === "string"
      ? maybeError.name.toLowerCase()
      : "";

  return (
    name === "aborterror" ||
    message.includes("operation cancelled") ||
    message.includes("cancelled") ||
    message.includes("aborted")
  );
}

export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.name === "TimeoutError" ||
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

  if (isCancelledError(error)) {
    return new OperationCancelledError("operation cancelled");
  }

  if (isTimeoutError(error)) {
    return new DownloadError("timeout exceeded");
  }

  return new DownloadError(fallbackMessage);
}
