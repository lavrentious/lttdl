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

    expect(settings.platformPreferences.youtube.preset).toBe("best");
  });

  test("parses invalid youtube preset as default", () => {
    expect(parseYoutubePresetInput("invalid")).toBe("best");
  });

  test("preserves youtube preset when toggling verbose output", () => {
    const userId = 101;
    updateUserYoutubePreset(userId, "best-audio");

    const updated = updateUserVerboseOutput(userId, true);

    expect(updated.verboseOutput).toBe(true);
    expect(updated.platformPreferences.youtube.preset).toBe("best-audio");
  });

  test("preserves youtube preset when updating tiktok providers", () => {
    const userId = 102;
    updateUserYoutubePreset(userId, "best-audio");

    const updated = updateUserTiktokProviders(userId, ["v1", "v2"]);

    expect(updated.platformPreferences.tiktok.providers).toEqual(["v1", "v2"]);
    expect(updated.platformPreferences.youtube.preset).toBe("best-audio");
  });

  test("persists youtube preset updates", () => {
    const userId = 103;
    updateUserYoutubePreset(userId, "best-audio");

    const settings = getUserSettings(userId);

    expect(settings.platformPreferences.youtube.preset).toBe("best-audio");
  });
});

process.on("exit", () => {
  rmSync(testDbDir, { recursive: true, force: true });
});
