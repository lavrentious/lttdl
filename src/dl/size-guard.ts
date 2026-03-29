const CONSERVATIVE_VIDEO_BYTES_PER_SECOND = 450 * 1024;

export function estimateVideoSizeFromDuration(durationSeconds: number): number {
  return durationSeconds * CONSERVATIVE_VIDEO_BYTES_PER_SECOND;
}

export function formatSizeMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isLikelyOversizeVideo(
  durationSeconds: number | undefined,
  maxFileSize: number | undefined,
): boolean {
  if (!durationSeconds || !maxFileSize || durationSeconds <= 0) {
    return false;
  }

  return estimateVideoSizeFromDuration(durationSeconds) > maxFileSize;
}

export function buildOversizeMessage({
  estimatedSizeBytes,
  exact,
}: {
  estimatedSizeBytes?: number;
  exact?: boolean;
} = {}): string {
  if (typeof estimatedSizeBytes === "number" && Number.isFinite(estimatedSizeBytes)) {
    return exact
      ? `video is too large to upload (${formatSizeMegabytes(estimatedSizeBytes)})`
      : `video is likely too large to upload (about ${formatSizeMegabytes(estimatedSizeBytes)})`;
  }

  return exact
    ? "video is too large to upload"
    : "video is likely too large to upload";
}
