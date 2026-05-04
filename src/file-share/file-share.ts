import { randomUUIDv7 } from "bun";
import { Database } from "bun:sqlite";
import { zipSync } from "fflate";
import { mkdirSync, readFileSync, rmSync } from "fs";
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
      expire_at  TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_shared_files_expire_at ON shared_files (expire_at);
  `);

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
    5 * 60 * 1000,
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
): Promise<string | null> {
  if (!config.get("FILE_SHARE_ENABLED") || !db || filePaths.length < 2)
    return null;
  try {
    const id = randomUUIDv7();
    const destFilename = `${id}.zip`;
    const destPath = path.join(config.get("FILE_SHARE_DIR"), destFilename);

    const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
    for (const filePath of filePaths) {
      entries[path.basename(filePath)] = [
        new Uint8Array(readFileSync(filePath)),
        { level: 0 },
      ];
    }
    await Bun.write(destPath, zipSync(entries));

    const expireAt = new Date(
      Date.now() + config.get("FILE_SHARE_TTL_S") * 1000,
    )
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    db.query(
      "INSERT INTO shared_files (id, file_path, expire_at) VALUES (?, ?, ?)",
    ).run(id, destPath, expireAt);

    const url = `${config.get("FILE_SHARE_BASE_URL")!.replace(/\/$/, "")}/${destFilename}`;
    logger.debug(`file-share: registered zip ${url} (expires ${expireAt})`);
    return url;
  } catch (err) {
    logError(err);
    return null;
  }
}

export async function shareFile(sourcePath: string): Promise<string | null> {
  if (!config.get("FILE_SHARE_ENABLED") || !db) return null;
  try {
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
      "INSERT INTO shared_files (id, file_path, expire_at) VALUES (?, ?, ?)",
    ).run(id, destPath, expireAt);

    const url = `${config.get("FILE_SHARE_BASE_URL")!.replace(/\/$/, "")}/${destFilename}`;
    logger.debug(`file-share: registered ${url} (expires ${expireAt})`);
    return url;
  } catch (err) {
    logError(err);
    return null;
  }
}
