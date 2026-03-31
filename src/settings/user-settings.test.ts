import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { config } from "src/utils/env-validation";
import {
  getDefaultUserSettings,
  getUserSettings,
  initUserSettingsDb,
  parseMusicSearchProviderInput,
  parseYoutubePresetInput,
  updateUserMusicSearchProvider,
  updateUserTiktokProviders,
  updateUserVerboseOutput,
  updateUserYoutubePreset,
} from "./user-settings";

const testDbDir = mkdtempSync(path.join(os.tmpdir(), "lttdl-settings-"));
config.init({
  NODE_ENV: "test",
  BOT_TOKEN: "test",
  TEMP_DIR: testDbDir,
  DB_PATH: path.join(testDbDir, "app.db"),
  YT_DLP_COOKIES_PATH: path.join(testDbDir, "cookies.txt"),
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
initUserSettingsDb();

describe("user settings", () => {
  test("returns youtube preset default", () => {
    const settings = getDefaultUserSettings();

    expect(settings.platformPreferences.youtube.preset).toBe("auto-video-audio");
  });

  test("returns music search provider default", () => {
    const settings = getDefaultUserSettings();

    expect(settings.platformPreferences.music.searchProvider).toBe("youtube-music");
  });

  test("parses invalid youtube preset as default", () => {
    expect(parseYoutubePresetInput("invalid")).toBe("auto-video-audio");
  });

  test("maps legacy automatic preset to the new default", () => {
    expect(parseYoutubePresetInput("automatic")).toBe("auto-video-audio");
  });

  test("parses invalid music search provider as default", () => {
    expect(parseMusicSearchProviderInput("invalid")).toBe("youtube-music");
  });

  test("parses youtube music provider aliases exactly", () => {
    expect(parseMusicSearchProviderInput("youtube")).toBe("youtube");
  });

  test("preserves youtube preset when toggling verbose output", () => {
    const userId = 101;
    updateUserYoutubePreset(userId, "mid-audio");
    updateUserMusicSearchProvider(userId, "youtube-music");

    const updated = updateUserVerboseOutput(userId, true);

    expect(updated.verboseOutput).toBe(true);
    expect(updated.platformPreferences.youtube.preset).toBe("mid-audio");
    expect(updated.platformPreferences.music.searchProvider).toBe("youtube-music");
  });

  test("preserves youtube preset when updating tiktok providers", () => {
    const userId = 102;
    updateUserYoutubePreset(userId, "fast-720");
    updateUserMusicSearchProvider(userId, "youtube-music");

    const updated = updateUserTiktokProviders(userId, ["v1", "v2"]);

    expect(updated.platformPreferences.tiktok.providers).toEqual(["v1", "v2"]);
    expect(updated.platformPreferences.youtube.preset).toBe("fast-720");
    expect(updated.platformPreferences.music.searchProvider).toBe("youtube-music");
  });

  test("persists youtube preset updates", () => {
    const userId = 103;
    updateUserYoutubePreset(userId, "fast-1080");

    const settings = getUserSettings(userId);

    expect(settings.platformPreferences.youtube.preset).toBe("fast-1080");
  });

  test("persists music provider updates", () => {
    const userId = 104;
    updateUserMusicSearchProvider(userId, "youtube");

    const settings = getUserSettings(userId);

    expect(settings.platformPreferences.music.searchProvider).toBe("youtube");
  });
});

process.on("exit", () => {
  rmSync(testDbDir, { recursive: true, force: true });
});
