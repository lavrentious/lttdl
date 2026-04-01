export class DownloadError extends Error {}
export class OperationCancelledError extends DownloadError {}

function normalizeMessageForUser(message: string): string {
  return message
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export function sanitizeDownloadErrorMessage(message: string): string {
  const normalized = normalizeMessageForUser(message);
  const lower = normalized.toLowerCase();

  if (
    (lower.includes("sign in to confirm your age") ||
      lower.includes("for the authentication")) &&
    (lower.includes("--cookies") || lower.includes("--cookies-from-browser"))
  ) {
    return "some results require authentication. enable music search cookies in /settings and try again.";
  }

  const firstErrorLine = normalized
    .split("\n")
    .find((line) => line.startsWith("ERROR:"));
  if (firstErrorLine) {
    return firstErrorLine.replace(/^ERROR:\s*/, "").trim();
  }

  if (normalized.length <= 300) {
    return normalized;
  }

  return `${normalized.slice(0, 297).trimEnd()}...`;
}

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

export function getUserFacingDownloadErrorMessage(error: unknown): string {
  return sanitizeDownloadErrorMessage(toDownloadError(error).message);
}
