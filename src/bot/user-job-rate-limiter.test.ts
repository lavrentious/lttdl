import { beforeEach, describe, expect, test } from "bun:test";
import {
  checkUserJobRateLimit,
  formatUserJobRateLimitMessage,
  recordUserJobStart,
  resetUserJobRateLimit,
  USER_JOB_DAY_WINDOW_MS,
  USER_JOB_MINUTE_WINDOW_MS,
} from "./user-job-rate-limiter";

describe("user job rate limiter", () => {
  beforeEach(() => {
    resetUserJobRateLimit();
  });

  test("allows up to ten starts within one minute", () => {
    const now = 1_000_000;

    for (let i = 0; i < 10; i += 1) {
      expect(recordUserJobStart(1, now + i)).toEqual({ allowed: true });
    }

    expect(checkUserJobRateLimit(1, now + 10)).toEqual({
      allowed: false,
      window: "minute",
      retryAfterMs: USER_JOB_MINUTE_WINDOW_MS - 10,
    });
  });

  test("allows new starts once the minute window expires", () => {
    const now = 2_000_000;

    for (let i = 0; i < 10; i += 1) {
      recordUserJobStart(1, now + i);
    }

    expect(recordUserJobStart(1, now + USER_JOB_MINUTE_WINDOW_MS + 1)).toEqual({
      allowed: true,
    });
  });

  test("enforces the daily limit independently of the minute limit", () => {
    const now = 3_000_000;

    for (let i = 0; i < 50; i += 1) {
      expect(recordUserJobStart(1, now + i * USER_JOB_MINUTE_WINDOW_MS)).toEqual({
        allowed: true,
      });
    }

    expect(checkUserJobRateLimit(1, now + 50 * USER_JOB_MINUTE_WINDOW_MS)).toEqual({
      allowed: false,
      window: "day",
      retryAfterMs: USER_JOB_DAY_WINDOW_MS - 50 * USER_JOB_MINUTE_WINDOW_MS,
    });
  });

  test("prunes day-old timestamps and allows new starts after a day passes", () => {
    const now = 4_000_000;

    for (let i = 0; i < 50; i += 1) {
      recordUserJobStart(1, now + i * USER_JOB_MINUTE_WINDOW_MS);
    }

    expect(
      recordUserJobStart(1, now + USER_JOB_DAY_WINDOW_MS + USER_JOB_MINUTE_WINDOW_MS),
    ).toEqual({
      allowed: true,
    });
  });

  test("does not consume the budget when only checking", () => {
    const now = 5_000_000;

    for (let i = 0; i < 10; i += 1) {
      expect(checkUserJobRateLimit(1, now + i)).toEqual({ allowed: true });
    }

    expect(recordUserJobStart(1, now + 20)).toEqual({ allowed: true });
  });

  test("formats rate limit messages for both windows", () => {
    expect(
      formatUserJobRateLimitMessage({
        allowed: false,
        window: "minute",
        retryAfterMs: 12_300,
      }),
    ).toBe("rate limit exceeded: max 10 heavy jobs per minute. try again in 13s.");

    expect(
      formatUserJobRateLimitMessage({
        allowed: false,
        window: "day",
        retryAfterMs: 3_900_000,
      }),
    ).toBe("rate limit exceeded: max 50 heavy jobs per day. try again in 1h 5m.");
  });
});
