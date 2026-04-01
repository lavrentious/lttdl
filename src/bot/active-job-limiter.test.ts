import { beforeEach, describe, expect, test } from "bun:test";
import os from "os";
import path from "path";
import { config } from "src/utils/env-validation";
import {
  finishUserJob,
  getActiveUserJobCount,
  tryStartUserJob,
} from "./active-job-limiter";

config.init({
  NODE_ENV: "test",
  BOT_TOKEN: "test",
  TEMP_DIR: os.tmpdir(),
  DB_PATH: path.join(os.tmpdir(), "lttdl-active-jobs-test.db"),
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
  YT_DLP_MUSIC_SEARCH_REMOTE_COMPONENTS: ["ejs:github"],
  NETWORK_FETCH_INFO_TIMEOUT_MS: 15000,
  NETWORK_FETCH_INFO_RETRIES: 1,
  NETWORK_RETRY_DELAY_MS: 300,
  ASSET_FILE_DOWNLOAD_TIMEOUT_MS: 45000,
  ASSET_FILE_DOWNLOAD_RETRIES: 1,
  VIDEO_FFPROBE_TIMEOUT_MS: 15000,
  VIDEO_FFMPEG_TIMEOUT_MS: 600000,
  IMAGE_PROCESS_TIMEOUT_MS: 15000,
});

describe("active job limiter", () => {
  beforeEach(() => {
    finishUserJob(1);
    finishUserJob(1);
    finishUserJob(1);
    finishUserJob(1);
    finishUserJob(1);
  });

  test("allows jobs until the per-user limit is reached", () => {
    expect(tryStartUserJob(1, 4)).toBe(true);
    expect(tryStartUserJob(1, 4)).toBe(true);
    expect(tryStartUserJob(1, 4)).toBe(true);
    expect(tryStartUserJob(1, 4)).toBe(true);
    expect(tryStartUserJob(1, 4)).toBe(false);
    expect(getActiveUserJobCount(1)).toBe(4);
  });

  test("releases active jobs back to zero", () => {
    expect(tryStartUserJob(1, 2)).toBe(true);
    expect(tryStartUserJob(1, 2)).toBe(true);

    finishUserJob(1);
    expect(getActiveUserJobCount(1)).toBe(1);

    finishUserJob(1);
    expect(getActiveUserJobCount(1)).toBe(0);
  });
});
