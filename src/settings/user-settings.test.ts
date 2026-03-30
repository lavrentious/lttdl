import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { config } from "src/utils/env-validation";
import {
  getDefaultUserSettings,
  getUserSettings,
  initUserSettingsDb,
  parseYoutubePresetInput,
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
});
initUserSettingsDb();

describe("user settings", () => {
  test("returns youtube preset default", () => {
    const settings = getDefaultUserSettings();

    expect(settings.platformPreferences.youtube.preset).toBe("auto-video-audio");
  });

  test("parses invalid youtube preset as default", () => {
    expect(parseYoutubePresetInput("invalid")).toBe("auto-video-audio");
  });

  test("maps legacy automatic preset to the new default", () => {
    expect(parseYoutubePresetInput("automatic")).toBe("auto-video-audio");
  });

  test("preserves youtube preset when toggling verbose output", () => {
    const userId = 101;
    updateUserYoutubePreset(userId, "mid-audio");

    const updated = updateUserVerboseOutput(userId, true);

    expect(updated.verboseOutput).toBe(true);
    expect(updated.platformPreferences.youtube.preset).toBe("mid-audio");
  });

  test("preserves youtube preset when updating tiktok providers", () => {
    const userId = 102;
    updateUserYoutubePreset(userId, "fast-720");

    const updated = updateUserTiktokProviders(userId, ["v1", "v2"]);

    expect(updated.platformPreferences.tiktok.providers).toEqual(["v1", "v2"]);
    expect(updated.platformPreferences.youtube.preset).toBe("fast-720");
  });

  test("persists youtube preset updates", () => {
    const userId = 103;
    updateUserYoutubePreset(userId, "fast-1080");

    const settings = getUserSettings(userId);

    expect(settings.platformPreferences.youtube.preset).toBe("fast-1080");
  });
});

process.on("exit", () => {
  rmSync(testDbDir, { recursive: true, force: true });
});
