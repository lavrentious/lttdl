import { config } from "src/utils/env-validation";

export function getUserJobMinuteWindowMs(): number {
  return config.get("BOT_USER_JOB_RATE_LIMIT_MINUTE_WINDOW_MS");
}

export function getUserJobDayWindowMs(): number {
  return config.get("BOT_USER_JOB_RATE_LIMIT_DAY_WINDOW_MS");
}

export type UserJobRateLimitWindow = "minute" | "day";

export type UserJobRateLimitResult =
  | { allowed: true }
  | {
      allowed: false;
      window: UserJobRateLimitWindow;
      retryAfterMs: number;
    };

const jobTimestampsByUser = new Map<number, number[]>();

function getUserJobMinuteLimit(): number {
  return config.get("BOT_USER_JOB_RATE_LIMIT_PER_MINUTE");
}

function getUserJobDayLimit(): number {
  return config.get("BOT_USER_JOB_RATE_LIMIT_PER_DAY");
}

function pruneExpiredTimestamps(timestamps: number[], now: number): number[] {
  return timestamps.filter((timestamp) => now - timestamp < getUserJobDayWindowMs());
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
  const minuteStarts = timestamps.filter((timestamp) => now - timestamp < getUserJobMinuteWindowMs());

  if (minuteStarts.length >= getUserJobMinuteLimit()) {
    const oldestMinuteTimestamp = minuteStarts[0]!;
    return {
      allowed: false,
      window: "minute",
      retryAfterMs: Math.max(getUserJobMinuteWindowMs() - (now - oldestMinuteTimestamp), 0),
    };
  }

  if (timestamps.length >= getUserJobDayLimit()) {
    const oldestDayTimestamp = timestamps[0]!;
    return {
      allowed: false,
      window: "day",
      retryAfterMs: Math.max(getUserJobDayWindowMs() - (now - oldestDayTimestamp), 0),
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
    return `rate limit exceeded: max ${getUserJobMinuteLimit()} heavy jobs per minute. try again in ${Math.ceil(result.retryAfterMs / 1000)}s.`;
  }

  const totalSeconds = Math.ceil(result.retryAfterMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.ceil((totalSeconds % 3600) / 60);
  return `rate limit exceeded: max ${getUserJobDayLimit()} heavy jobs per day. try again in ${hours}h ${minutes}m.`;
}

export function resetUserJobRateLimit(userId?: number) {
  if (typeof userId === "number") {
    jobTimestampsByUser.delete(userId);
    return;
  }

  jobTimestampsByUser.clear();
}
