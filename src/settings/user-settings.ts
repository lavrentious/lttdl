import { mkdirSync } from "fs";
import path from "path";
import { Database } from "bun:sqlite";
import { ALL_DOWNLOAD_SOURCES, DownloadSource } from "src/dl/downloader";
import { config } from "src/utils/env-validation";
import { logger } from "src/utils/logger";

export type UserSettings = {
  verboseOutput: boolean;
  downloadSources: DownloadSource[];
};

type UserSettingsRow = {
  verbose_output: number;
  download_sources: string;
};

const DEFAULT_USER_SETTINGS: UserSettings = {
  verboseOutput: false,
  downloadSources: [DownloadSource.V2],
};

let db: Database | null = null;

function sortDownloadSources(sources: DownloadSource[]): DownloadSource[] {
  return [...sources].sort(
    (a, b) => ALL_DOWNLOAD_SOURCES.indexOf(a) - ALL_DOWNLOAD_SOURCES.indexOf(b),
  );
}

function normalizeDownloadSources(
  sources: readonly (string | DownloadSource)[],
): DownloadSource[] {
  const uniqueSources = Array.from(
    new Set(
      sources.filter((source): source is DownloadSource =>
        ALL_DOWNLOAD_SOURCES.includes(source as DownloadSource),
      ),
    ),
  );

  if (!uniqueSources.length) {
    throw new Error("at least one download source must be enabled");
  }

  return sortDownloadSources(uniqueSources);
}

function getDbOrThrow(): Database {
  if (!db) {
    throw new Error("user settings database is not initialized");
  }
  return db;
}

function parseDownloadSources(value: string): DownloadSource[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error("download_sources must be an array");
    }
    return normalizeDownloadSources(parsed);
  } catch (err) {
    logger.warn(`failed to parse user settings download sources: ${String(err)}`);
    return DEFAULT_USER_SETTINGS.downloadSources;
  }
}

function rowToUserSettings(row: UserSettingsRow): UserSettings {
  return {
    verboseOutput: Boolean(row.verbose_output),
    downloadSources: parseDownloadSources(row.download_sources),
  };
}

export function initUserSettingsDb() {
  if (db) return;

  const dbPath = config.get("DB_PATH");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY,
      verbose_output INTEGER NOT NULL DEFAULT 0,
      download_sources TEXT NOT NULL DEFAULT '["v2"]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export function getDefaultUserSettings(): UserSettings {
  return {
    verboseOutput: DEFAULT_USER_SETTINGS.verboseOutput,
    downloadSources: [...DEFAULT_USER_SETTINGS.downloadSources],
  };
}

export function getUserSettings(userId: number): UserSettings {
  const row = getDbOrThrow()
    .query("SELECT verbose_output, download_sources FROM user_settings WHERE user_id = ?")
    .get(userId) as UserSettingsRow | null;

  if (!row) {
    return getDefaultUserSettings();
  }

  return rowToUserSettings(row);
}

export function updateUserVerboseOutput(
  userId: number,
  verboseOutput: boolean,
): UserSettings {
  getDbOrThrow()
    .query(
      `
        INSERT INTO user_settings (user_id, verbose_output, download_sources, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          verbose_output = excluded.verbose_output,
          updated_at = CURRENT_TIMESTAMP
      `,
    )
    .run(
      userId,
      Number(verboseOutput),
      JSON.stringify(DEFAULT_USER_SETTINGS.downloadSources),
    );

  return getUserSettings(userId);
}

export function updateUserDownloadSources(
  userId: number,
  downloadSources: DownloadSource[],
): UserSettings {
  const normalizedSources = normalizeDownloadSources(downloadSources);

  getDbOrThrow()
    .query(
      `
        INSERT INTO user_settings (user_id, verbose_output, download_sources, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          download_sources = excluded.download_sources,
          updated_at = CURRENT_TIMESTAMP
      `,
    )
    .run(
      userId,
      Number(DEFAULT_USER_SETTINGS.verboseOutput),
      JSON.stringify(normalizedSources),
    );

  return getUserSettings(userId);
}

export function parseDownloadSourcesInput(input: string): DownloadSource[] {
  const sources = input
    .split(",")
    .map((source) => source.trim().toLowerCase())
    .filter(Boolean);

  return normalizeDownloadSources(sources);
}
