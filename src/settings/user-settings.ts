import { mkdirSync } from "fs";
import path from "path";
import { Database } from "bun:sqlite";
import {
  ALL_TIKTOK_PROVIDERS,
  type TiktokProvider,
} from "src/dl/platforms/tiktok/types";
import { config } from "src/utils/env-validation";
import { logger } from "src/utils/logger";

export type UserSettings = {
  verboseOutput: boolean;
  platformPreferences: {
    tiktok: {
      providers: TiktokProvider[];
    };
  };
};

type UserSettingsRow = {
  verbose_output: number;
  tiktok_providers: string;
};

const DEFAULT_TIKTOK_PROVIDERS: TiktokProvider[] = ["v2"];

const DEFAULT_USER_SETTINGS: UserSettings = {
  verboseOutput: false,
  platformPreferences: {
    tiktok: {
      providers: DEFAULT_TIKTOK_PROVIDERS,
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
    },
  };
}

function ensureTiktokProvidersColumn(database: Database) {
  try {
    database.exec(`
      ALTER TABLE user_settings RENAME COLUMN download_sources TO tiktok_providers;
    `);
  } catch {}
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  ensureTiktokProvidersColumn(db);
}

export function getDefaultUserSettings(): UserSettings {
  return {
    verboseOutput: DEFAULT_USER_SETTINGS.verboseOutput,
    platformPreferences: {
      tiktok: {
        providers: [...DEFAULT_USER_SETTINGS.platformPreferences.tiktok.providers],
      },
    },
  };
}

export function getUserSettings(userId: number): UserSettings {
  const row = getDbOrThrow()
    .query("SELECT verbose_output, tiktok_providers FROM user_settings WHERE user_id = ?")
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
        INSERT INTO user_settings (user_id, verbose_output, tiktok_providers, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          verbose_output = excluded.verbose_output,
          updated_at = CURRENT_TIMESTAMP
      `,
    )
    .run(userId, Number(verboseOutput), JSON.stringify(DEFAULT_TIKTOK_PROVIDERS));

  return getUserSettings(userId);
}

export function updateUserTiktokProviders(
  userId: number,
  providers: TiktokProvider[],
): UserSettings {
  const normalizedProviders = normalizeTiktokProviders(providers);

  getDbOrThrow()
    .query(
      `
        INSERT INTO user_settings (user_id, verbose_output, tiktok_providers, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          tiktok_providers = excluded.tiktok_providers,
          updated_at = CURRENT_TIMESTAMP
      `,
    )
    .run(
      userId,
      Number(DEFAULT_USER_SETTINGS.verboseOutput),
      JSON.stringify(normalizedProviders),
    );

  return getUserSettings(userId);
}

export function parseTiktokProvidersInput(input: string): TiktokProvider[] {
  const providers = input
    .split(",")
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);

  return normalizeTiktokProviders(providers);
}
