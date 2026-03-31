export const USER_JOB_MINUTE_LIMIT = 10;
export const USER_JOB_DAY_LIMIT = 50;
export const USER_JOB_MINUTE_WINDOW_MS = 60 * 1000;
export const USER_JOB_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type UserJobRateLimitWindow = "minute" | "day";

export type UserJobRateLimitResult =
  | { allowed: true }
  | {
      allowed: false;
      window: UserJobRateLimitWindow;
      retryAfterMs: number;
    };

const jobTimestampsByUser = new Map<number, number[]>();

function pruneExpiredTimestamps(timestamps: number[], now: number): number[] {
  return timestamps.filter((timestamp) => now - timestamp < USER_JOB_DAY_WINDOW_MS);
}

function getUserJobTimestamps(userId: number, now: number): number[] {
  const pruned = pruneExpiredTimestamps(jobTimestampsByUser.get(userId) || [], now);
  jobTimestampsByUser.set(userId, pruned);
  return pruned;
}

export function checkUserJobRateLimit(
  userId: number,
  now = Date.now(),
): UserJobRateLimitResult {
  const timestamps = getUserJobTimestamps(userId, now);
  const minuteStarts = timestamps.filter((timestamp) => now - timestamp < USER_JOB_MINUTE_WINDOW_MS);

  if (minuteStarts.length >= USER_JOB_MINUTE_LIMIT) {
    const oldestMinuteTimestamp = minuteStarts[0]!;
    return {
      allowed: false,
      window: "minute",
      retryAfterMs: Math.max(USER_JOB_MINUTE_WINDOW_MS - (now - oldestMinuteTimestamp), 0),
    };
  }

  if (timestamps.length >= USER_JOB_DAY_LIMIT) {
    const oldestDayTimestamp = timestamps[0]!;
    return {
      allowed: false,
      window: "day",
      retryAfterMs: Math.max(USER_JOB_DAY_WINDOW_MS - (now - oldestDayTimestamp), 0),
    };
  }

  return { allowed: true };
}

export function recordUserJobStart(
  userId: number,
  now = Date.now(),
): UserJobRateLimitResult {
  const result = checkUserJobRateLimit(userId, now);
  if (!result.allowed) {
    return result;
  }

  const timestamps = getUserJobTimestamps(userId, now);
  timestamps.push(now);
  return result;
}

export function formatUserJobRateLimitMessage(result: Extract<UserJobRateLimitResult, {
  allowed: false;
}>): string {
  if (result.window === "minute") {
    return `rate limit exceeded: max ${USER_JOB_MINUTE_LIMIT} heavy jobs per minute. try again in ${Math.ceil(result.retryAfterMs / 1000)}s.`;
  }

  const totalSeconds = Math.ceil(result.retryAfterMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.ceil((totalSeconds % 3600) / 60);
  return `rate limit exceeded: max ${USER_JOB_DAY_LIMIT} heavy jobs per day. try again in ${hours}h ${minutes}m.`;
}

export function resetUserJobRateLimit(userId?: number) {
  if (typeof userId === "number") {
    jobTimestampsByUser.delete(userId);
    return;
  }

  jobTimestampsByUser.clear();
}
