import { beforeEach, describe, expect, test } from "bun:test";
import os from "os";
import path from "path";
import { config } from "src/utils/env-validation";
import {
  checkUserJobRateLimit,
  formatUserJobRateLimitMessage,
  getUserJobDayWindowMs,
  getUserJobMinuteWindowMs,
  recordUserJobStart,
  resetUserJobRateLimit,
} from "./user-job-rate-limiter";

config.init({
  NODE_ENV: "test",
  BOT_TOKEN: "test",
  TEMP_DIR: os.tmpdir(),
  DB_PATH: path.join(os.tmpdir(), "lttdl-rate-limit-test.db"),
  YT_DLP_COOKIES_PATH: path.join(os.tmpdir(), "lttdl-cookies.txt"),
  BOT_MAX_FILE_SIZE_MB: 50,
  BOT_PROGRESS_UPDATE_INTERVAL_MS: 1200,
  BOT_MAX_ACTIVE_JOBS_PER_USER: 4,
  BOT_MUSIC_PAGE_SIZE: 5,
  BOT_MUSIC_SEARCH_LIMIT: 20,
  BOT_MUSIC_SEARCH_TTL_MS: 600000,
  BOT_USER_JOB_RATE_LIMIT_PER_MINUTE: 10,
  BOT_USER_JOB_RATE_LIMIT_PER_DAY: 50,
  BOT_USER_JOB_RATE_LIMIT_MINUTE_WINDOW_MS: 60000,
  BOT_USER_JOB_RATE_LIMIT_DAY_WINDOW_MS: 86400000,
  YT_DLP_CONCURRENT_FRAGMENTS: 4,
  YT_DLP_YOUTUBE_METADATA_TIMEOUT_MS: 30000,
  YT_DLP_YOUTUBE_DOWNLOAD_TIMEOUT_MS: 1200000,
  YT_DLP_MUSIC_SEARCH_TIMEOUT_MS: 120000,
  YT_DLP_MUSIC_METADATA_TIMEOUT_MS: 30000,
  YT_DLP_MUSIC_DOWNLOAD_TIMEOUT_MS: 1200000,
  YT_DLP_THUMBNAIL_FETCH_TIMEOUT_MS: 15000,
  NETWORK_FETCH_INFO_TIMEOUT_MS: 15000,
  NETWORK_FETCH_INFO_RETRIES: 1,
  NETWORK_RETRY_DELAY_MS: 300,
  ASSET_FILE_DOWNLOAD_TIMEOUT_MS: 45000,
  ASSET_FILE_DOWNLOAD_RETRIES: 1,
  VIDEO_FFPROBE_TIMEOUT_MS: 15000,
  VIDEO_FFMPEG_TIMEOUT_MS: 600000,
  IMAGE_PROCESS_TIMEOUT_MS: 15000,
});

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
      retryAfterMs: getUserJobMinuteWindowMs() - 10,
    });
  });

  test("allows new starts once the minute window expires", () => {
    const now = 2_000_000;

    for (let i = 0; i < 10; i += 1) {
      recordUserJobStart(1, now + i);
    }

    expect(recordUserJobStart(1, now + getUserJobMinuteWindowMs() + 1)).toEqual({
      allowed: true,
    });
  });

  test("enforces the daily limit independently of the minute limit", () => {
    const now = 3_000_000;

    for (let i = 0; i < 50; i += 1) {
      expect(recordUserJobStart(1, now + i * getUserJobMinuteWindowMs())).toEqual({
        allowed: true,
      });
    }

    expect(checkUserJobRateLimit(1, now + 50 * getUserJobMinuteWindowMs())).toEqual({
      allowed: false,
      window: "day",
      retryAfterMs: getUserJobDayWindowMs() - 50 * getUserJobMinuteWindowMs(),
    });
  });

  test("prunes day-old timestamps and allows new starts after a day passes", () => {
    const now = 4_000_000;

    for (let i = 0; i < 50; i += 1) {
      recordUserJobStart(1, now + i * getUserJobMinuteWindowMs());
    }

    expect(
      recordUserJobStart(1, now + getUserJobDayWindowMs() + getUserJobMinuteWindowMs()),
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
