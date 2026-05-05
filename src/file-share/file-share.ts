import { randomUUIDv7 } from "bun";
import { Database } from "bun:sqlite";
import { zipSync } from "fflate";
import { mkdirSync, readFileSync, rmSync, statSync } from "fs";
import { copyFile } from "fs/promises";
import path from "path";
import { config } from "src/utils/env-validation";
import { logError, logger } from "src/utils/logger";

type SharedFileRow = { id: string; file_path: string };

let db: Database | null = null;

function getDb(): Database {
  if (!db) throw new Error("file-share database is not initialized");
  return db;
}

function getTotalTrackedBytes(): number {
  const row = getDb()
    .query("SELECT COALESCE(SUM(file_size), 0) as total FROM shared_files")
    .get() as { total: number };
  return row.total;
}

function wouldExceedCap(additionalBytes: number): boolean {
  const maxMb = config.get("FILE_SHARE_MAX_DIR_SIZE_MB");
  if (maxMb === 0) return false;
  return getTotalTrackedBytes() + additionalBytes > maxMb * 1024 * 1024;
}

function ensureSharedFilesColumns(database: Database): void {
  try {
    database.exec(
      `ALTER TABLE shared_files ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0;`,
    );
  } catch {}
  try {
    database.exec(`ALTER TABLE shared_files ADD COLUMN user_id INTEGER;`);
  } catch {}
}

function deleteExpiredFiles(): void {
  const database = getDb();
  const rows = database
    .query(
      "SELECT id, file_path FROM shared_files WHERE expire_at <= datetime('now')",
    )
    .all() as SharedFileRow[];

  for (const row of rows) {
    try {
      rmSync(row.file_path, { force: true });
    } catch (err) {
      logger.warn(
        `file-share: failed to delete ${row.file_path}: ${String(err)}`,
      );
    }
  }

  if (rows.length) {
    const placeholders = rows.map(() => "?").join(",");
    database
      .query(`DELETE FROM shared_files WHERE id IN (${placeholders})`)
      .run(...rows.map((r) => r.id));
    logger.info(`file-share: cleaned up ${rows.length} expired file(s)`);
  }
}

export function initFileShare(): void {
  if (!config.get("FILE_SHARE_ENABLED")) return;

  const baseUrl = config.get("FILE_SHARE_BASE_URL");
  if (!baseUrl) {
    throw new Error(
      "FILE_SHARE_ENABLED is true but FILE_SHARE_BASE_URL is not set",
    );
  }

  const shareDir = config.get("FILE_SHARE_DIR");
  mkdirSync(shareDir, { recursive: true });

  const dbPath = config.get("DB_PATH");
  db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_files (
      id         TEXT NOT NULL PRIMARY KEY,
      file_path  TEXT NOT NULL,
      file_size  INTEGER NOT NULL DEFAULT 0,
      user_id    INTEGER,
      expire_at  TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_shared_files_expire_at ON shared_files (expire_at);
  `);
  ensureSharedFilesColumns(db);

  deleteExpiredFiles();
  logger.info("file-share: straggler cleanup complete");

  setInterval(
    () => {
      try {
        deleteExpiredFiles();
      } catch (err) {
        logError(err);
      }
    },
    config.get("FILE_SHARE_CLEANUP_INTERVAL_S") * 1000,
  ).unref();

  if (config.get("FILE_SHARE_SERVER_MODE") === "builtin") {
    const port = config.get("FILE_SHARE_SERVER_PORT");
    const resolvedShareDir = path.resolve(shareDir);
    Bun.serve({
      port,
      async fetch(req) {
        const url = new URL(req.url);
        const filename = path.basename(url.pathname);
        if (!filename) return new Response("not found", { status: 404 });
        const filePath = path.join(resolvedShareDir, filename);
        if (!filePath.startsWith(resolvedShareDir + path.sep)) {
          return new Response("not found", { status: 404 });
        }
        const file = Bun.file(filePath);
        if (!(await file.exists()))
          return new Response("not found", { status: 404 });
        return new Response(file, {
          headers: {
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        });
      },
    });
    logger.info(`file-share: built-in server listening on port ${port}`);
  }
}

export async function createAndShareZip(
  filePaths: string[],
  userId: number | null,
): Promise<string | null> {
  if (!config.get("FILE_SHARE_ENABLED") || !db || filePaths.length < 2)
    return null;
  try {
    const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
    for (const filePath of filePaths) {
      entries[path.basename(filePath)] = [
        new Uint8Array(readFileSync(filePath)),
        { level: 0 },
      ];
    }
    const zipData = zipSync(entries);

    if (wouldExceedCap(zipData.byteLength)) {
      logger.warn(
        `file-share: skipping zip (${(zipData.byteLength / 1024 / 1024).toFixed(1)} MB) — would exceed FILE_SHARE_MAX_DIR_SIZE_MB`,
      );
      return null;
    }

    const id = randomUUIDv7();
    const destFilename = `${id}.zip`;
    const destPath = path.join(config.get("FILE_SHARE_DIR"), destFilename);
    await Bun.write(destPath, zipData);

    const expireAt = new Date(
      Date.now() + config.get("FILE_SHARE_TTL_S") * 1000,
    )
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    db.query(
      "INSERT INTO shared_files (id, file_path, file_size, user_id, expire_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, destPath, zipData.byteLength, userId, expireAt);

    const url = `${config.get("FILE_SHARE_BASE_URL")!.replace(/\/$/, "")}/${destFilename}`;
    logger.debug(`file-share: registered zip ${url} (expires ${expireAt})`);
    return url;
  } catch (err) {
    logError(err);
    return null;
  }
}

export async function shareFile(
  sourcePath: string,
  userId: number | null,
): Promise<string | null> {
  if (!config.get("FILE_SHARE_ENABLED") || !db) return null;
  try {
    const fileSize = statSync(sourcePath).size;

    if (wouldExceedCap(fileSize)) {
      logger.warn(
        `file-share: skipping ${path.basename(sourcePath)} (${(fileSize / 1024 / 1024).toFixed(1)} MB) — would exceed FILE_SHARE_MAX_DIR_SIZE_MB`,
      );
      return null;
    }

    const id = randomUUIDv7();
    const ext = path.extname(sourcePath);
    const destFilename = `${id}${ext}`;
    const destPath = path.join(config.get("FILE_SHARE_DIR"), destFilename);
    await copyFile(sourcePath, destPath);

    const expireAt = new Date(
      Date.now() + config.get("FILE_SHARE_TTL_S") * 1000,
    )
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    db.query(
      "INSERT INTO shared_files (id, file_path, file_size, user_id, expire_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, destPath, fileSize, userId, expireAt);

    const url = `${config.get("FILE_SHARE_BASE_URL")!.replace(/\/$/, "")}/${destFilename}`;
    logger.debug(`file-share: registered ${url} (expires ${expireAt})`);
    return url;
  } catch (err) {
    logError(err);
    return null;
  }
}
