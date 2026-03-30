import { mkdirSync } from "fs";
import path from "path";
import { Database } from "bun:sqlite";
import {
  ALL_TIKTOK_PROVIDERS,
  type TiktokProvider,
} from "src/dl/platforms/tiktok/types";
import {
  ALL_YOUTUBE_PRESETS,
  DEFAULT_YOUTUBE_PRESET,
} from "src/dl/platforms/youtube/types";
import {
  ALL_MUSIC_SEARCH_PROVIDERS,
  DEFAULT_MUSIC_SEARCH_PROVIDER,
  type MusicSearchProviderId,
} from "src/dl/music/types";
import type { YoutubePreset } from "src/dl/types";
import { config } from "src/utils/env-validation";
import { logger } from "src/utils/logger";

export type UserSettings = {
  verboseOutput: boolean;
  platformPreferences: {
    tiktok: {
      providers: TiktokProvider[];
    };
    youtube: {
      preset: YoutubePreset;
    };
    music: {
      searchProvider: MusicSearchProviderId;
    };
  };
};

type UserSettingsRow = {
  verbose_output: number;
  tiktok_providers: string;
  youtube_preset: string;
  music_search_provider: string;
};

const DEFAULT_TIKTOK_PROVIDERS: TiktokProvider[] = ["v2"];
const DEFAULT_USER_SETTINGS: UserSettings = {
  verboseOutput: false,
  platformPreferences: {
    tiktok: {
      providers: DEFAULT_TIKTOK_PROVIDERS,
    },
    youtube: {
      preset: DEFAULT_YOUTUBE_PRESET,
    },
    music: {
      searchProvider: DEFAULT_MUSIC_SEARCH_PROVIDER,
    },
  },
};

let db: Database | null = null;

function sortTiktokProviders(providers: TiktokProvider[]): TiktokProvider[] {
  return [...providers].sort(
    (a, b) => ALL_TIKTOK_PROVIDERS.indexOf(a) - ALL_TIKTOK_PROVIDERS.indexOf(b),
  );
}

function normalizeTiktokProviders(
  providers: readonly (string | TiktokProvider)[],
): TiktokProvider[] {
  const uniqueProviders = Array.from(
    new Set(
      providers.filter((provider): provider is TiktokProvider =>
        ALL_TIKTOK_PROVIDERS.includes(provider as TiktokProvider),
      ),
    ),
  );

  if (!uniqueProviders.length) {
    throw new Error("at least one tiktok provider must be enabled");
  }

  return sortTiktokProviders(uniqueProviders);
}

function normalizeYoutubePreset(value: string): YoutubePreset {
  if (value === "automatic") {
    return DEFAULT_YOUTUBE_PRESET;
  }

  return ALL_YOUTUBE_PRESETS.includes(value as YoutubePreset)
    ? (value as YoutubePreset)
    : DEFAULT_YOUTUBE_PRESET;
}

function normalizeMusicSearchProvider(value: string): MusicSearchProviderId {
  return ALL_MUSIC_SEARCH_PROVIDERS.includes(value as MusicSearchProviderId)
    ? (value as MusicSearchProviderId)
    : DEFAULT_MUSIC_SEARCH_PROVIDER;
}

function getDbOrThrow(): Database {
  if (!db) {
    throw new Error("user settings database is not initialized");
  }
  return db;
}

function parseTiktokProviders(value: string): TiktokProvider[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error("tiktok_providers must be an array");
    }
    return normalizeTiktokProviders(parsed);
  } catch (err) {
    logger.warn(`failed to parse user settings tiktok providers: ${String(err)}`);
    return [...DEFAULT_TIKTOK_PROVIDERS];
  }
}

function rowToUserSettings(row: UserSettingsRow): UserSettings {
  return {
    verboseOutput: Boolean(row.verbose_output),
    platformPreferences: {
      tiktok: {
        providers: parseTiktokProviders(row.tiktok_providers),
      },
      youtube: {
        preset: normalizeYoutubePreset(row.youtube_preset),
      },
      music: {
        searchProvider: normalizeMusicSearchProvider(row.music_search_provider),
      },
    },
  };
}

function ensureUserSettingsColumns(database: Database) {
  try {
    database.exec(`
      ALTER TABLE user_settings RENAME COLUMN download_sources TO tiktok_providers;
    `);
  } catch {}

  try {
    database.exec(`
      ALTER TABLE user_settings ADD COLUMN youtube_preset TEXT NOT NULL DEFAULT 'auto-video-audio';
    `);
  } catch {}

  try {
    database.exec(`
      ALTER TABLE user_settings ADD COLUMN music_search_provider TEXT NOT NULL DEFAULT 'youtube-music';
    `);
  } catch {}
}

function upsertUserSettings(userId: number, nextSettings: UserSettings): UserSettings {
  getDbOrThrow()
    .query(
      `
        INSERT INTO user_settings (
          user_id,
          verbose_output,
          tiktok_providers,
          youtube_preset,
          music_search_provider,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          verbose_output = excluded.verbose_output,
          tiktok_providers = excluded.tiktok_providers,
          youtube_preset = excluded.youtube_preset,
          music_search_provider = excluded.music_search_provider,
          updated_at = CURRENT_TIMESTAMP
      `,
    )
    .run(
      userId,
      Number(nextSettings.verboseOutput),
      JSON.stringify(nextSettings.platformPreferences.tiktok.providers),
      nextSettings.platformPreferences.youtube.preset,
      nextSettings.platformPreferences.music.searchProvider,
    );

  return getUserSettings(userId);
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
      tiktok_providers TEXT NOT NULL DEFAULT '["v2"]',
      youtube_preset TEXT NOT NULL DEFAULT 'auto-video-audio',
      music_search_provider TEXT NOT NULL DEFAULT 'youtube-music',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  ensureUserSettingsColumns(db);
}

export function getDefaultUserSettings(): UserSettings {
  return {
    verboseOutput: DEFAULT_USER_SETTINGS.verboseOutput,
    platformPreferences: {
      tiktok: {
        providers: [...DEFAULT_USER_SETTINGS.platformPreferences.tiktok.providers],
      },
      youtube: {
        preset: DEFAULT_USER_SETTINGS.platformPreferences.youtube.preset,
      },
      music: {
        searchProvider: DEFAULT_USER_SETTINGS.platformPreferences.music.searchProvider,
      },
    },
  };
}

export function getUserSettings(userId: number): UserSettings {
  const row = getDbOrThrow()
    .query(
      "SELECT verbose_output, tiktok_providers, youtube_preset, music_search_provider FROM user_settings WHERE user_id = ?",
    )
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
  const current = getUserSettings(userId);

  return upsertUserSettings(userId, {
    ...current,
    verboseOutput,
  });
}

export function updateUserTiktokProviders(
  userId: number,
  providers: TiktokProvider[],
): UserSettings {
  const current = getUserSettings(userId);

  return upsertUserSettings(userId, {
    ...current,
    platformPreferences: {
      ...current.platformPreferences,
      tiktok: {
        providers: normalizeTiktokProviders(providers),
      },
    },
  });
}

export function updateUserYoutubePreset(
  userId: number,
  preset: YoutubePreset,
): UserSettings {
  const current = getUserSettings(userId);

  return upsertUserSettings(userId, {
    ...current,
    platformPreferences: {
      ...current.platformPreferences,
      youtube: {
        preset: normalizeYoutubePreset(preset),
      },
    },
  });
}

export function updateUserMusicSearchProvider(
  userId: number,
  searchProvider: MusicSearchProviderId,
): UserSettings {
  const current = getUserSettings(userId);

  return upsertUserSettings(userId, {
    ...current,
    platformPreferences: {
      ...current.platformPreferences,
      music: {
        searchProvider: normalizeMusicSearchProvider(searchProvider),
      },
    },
  });
}

export function parseTiktokProvidersInput(input: string): TiktokProvider[] {
  const providers = input
    .split(",")
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);

  return normalizeTiktokProviders(providers);
}

export function parseYoutubePresetInput(input: string): YoutubePreset {
  return normalizeYoutubePreset(input.trim().toLowerCase());
}

export function parseMusicSearchProviderInput(
  input: string,
): MusicSearchProviderId {
  return normalizeMusicSearchProvider(input.trim().toLowerCase());
}
