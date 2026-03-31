import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "fs";
import os from "os";
import path from "path";
import {
  DownloadError,
  OperationCancelledError,
} from "src/errors/download-error";
import {
  extractInstagramShortcode,
  InstagramPlatformHandler,
} from "./instagram-platform-handler";

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lttdl-instagram-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("extractInstagramShortcode", () => {
  test("extracts shortcode from post links", () => {
    expect(
      extractInstagramShortcode("https://instagram.com/p/abcdef?utm_source=ig_web_copy_link"),
    ).toBe("abcdef");
  });

  test("extracts shortcode from reel links", () => {
    expect(extractInstagramShortcode("https://www.instagram.com/reel/abc_DEF-1/")).toBe(
      "abc_DEF-1",
    );
  });

  test("rejects unsupported instagram links", () => {
    expect(() => extractInstagramShortcode("https://www.instagram.com/stories/user/123")).toThrow(
      new DownloadError("unsupported instagram link"),
    );
  });
});

describe("InstagramPlatformHandler", () => {
  test("fails clearly when instaloader is missing", async () => {
    const handler = new InstagramPlatformHandler({
      which: () => null,
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      getImageResolution: async () => ({ width: 1, height: 1 }),
      getVideoMetadata: async () => ({ width: 1, height: 1 }),
    });

    await expect(handler.download!("https://instagram.com/p/abcdef/")).rejects.toThrow(
      new DownloadError("instaloader is not installed"),
    );
  });

  test("downloads a single image post", async () => {
    const tempDir = createTempDir();
    const handler = new InstagramPlatformHandler({
      which: () => "/usr/bin/instaloader",
      runCommand: async (_cmd, workdir) => {
        await Bun.write(path.join(workdir, "lttdl_.jpg"), "image");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      getImageResolution: async () => ({ width: 1080, height: 1350 }),
      getVideoMetadata: async () => ({ width: 1, height: 1 }),
    });

    const result = await handler.download!(
      "https://instagram.com/p/abcdef/",
      {},
      { tempDir },
    );

    expect(result.res.contentType).toBe("image");
    if (result.res.contentType === "image") {
      expect(result.res.variants).toHaveLength(1);
      expect(result.res.variants[0]?.[0]?.downloaded).toBe(true);
    }

    result.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("downloads a single video reel", async () => {
    const tempDir = createTempDir();
    const handler = new InstagramPlatformHandler({
      which: () => "/usr/bin/instaloader",
      runCommand: async (_cmd, workdir) => {
        await Bun.write(path.join(workdir, "lttdl_.mp4"), "video");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      getImageResolution: async () => ({ width: 1, height: 1 }),
      getVideoMetadata: async () => ({
        width: 1080,
        height: 1920,
        durationSeconds: 12,
      }),
    });

    const result = await handler.download!(
      "https://instagram.com/reel/abcdef/",
      {},
      { tempDir },
    );

    expect(result.res.contentType).toBe("video");
    if (result.res.contentType === "video") {
      expect(result.res.variants[0]?.downloaded).toBe(true);
      if (result.res.variants[0]?.downloaded) {
        expect(result.res.variants[0].payload.durationSeconds).toBe(12);
      }
    }

    result.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("downloads a carousel as gallery", async () => {
    const tempDir = createTempDir();
    const handler = new InstagramPlatformHandler({
      which: () => "/usr/bin/instaloader",
      runCommand: async (_cmd, workdir) => {
        await Bun.write(path.join(workdir, "lttdl_1.jpg"), "image");
        await Bun.write(path.join(workdir, "lttdl_2.mp4"), "video");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      getImageResolution: async () => ({ width: 1080, height: 1080 }),
      getVideoMetadata: async () => ({
        width: 1080,
        height: 1350,
        durationSeconds: 8,
      }),
    });

    const result = await handler.download!(
      "https://instagram.com/p/abcdef/",
      {},
      { tempDir },
    );

    expect(result.res.contentType).toBe("gallery");
    if (result.res.contentType === "gallery") {
      expect(result.res.entries).toHaveLength(2);
    }

    result.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("cleans up the workdir when cancelled after files are downloaded", async () => {
    const tempDir = createTempDir();
    const controller = new AbortController();
    const handler = new InstagramPlatformHandler({
      which: () => "/usr/bin/instaloader",
      runCommand: async (_cmd, workdir) => {
        await Bun.write(path.join(workdir, "lttdl_.jpg"), "image");
        controller.abort(new OperationCancelledError("operation cancelled"));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      getImageResolution: async () => ({ width: 1080, height: 1350 }),
      getVideoMetadata: async () => ({ width: 1, height: 1 }),
    });

    await expect(
      handler.download!(
        "https://instagram.com/p/abcdef/",
        {},
        { tempDir, signal: controller.signal },
      ),
    ).rejects.toThrow("operation cancelled");

    expect(readdirSync(tempDir)).toEqual([]);
    rmSync(tempDir, { recursive: true, force: true });
  });
});
