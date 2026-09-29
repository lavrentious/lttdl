import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { config } from "src/utils/env-validation";
import { XPlatformHandler } from "./x-platform-handler";

config.init({
  TEMP_DIR: os.tmpdir(),
  YT_DLP_YOUTUBE_DOWNLOAD_TIMEOUT_MS: 1200000,
} as Parameters<typeof config.init>[0]);

function createHandler(fileCount: number, calls: string[][] = []) {
  return new XPlatformHandler({
    which: () => "/usr/bin/yt-dlp",
    runCommand: async (cmd) => {
      calls.push(cmd);
      const template = cmd[cmd.indexOf("--output") + 1]!;
      for (let i = 1; i <= fileCount; i++) {
        await Bun.write(
          template
            .replace("%(autonumber)s", String(i).padStart(5, "0"))
            .replace("%(ext)s", "mp4"),
          "video",
        );
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    getVideoMetadata: async () => ({
      width: 576,
      height: 704,
      durationSeconds: 15,
    }),
  });
}

describe("XPlatformHandler", () => {
  test("handles x/twitter hosts only", () => {
    const handler = createHandler(1);
    expect(handler.canHandle("https://x.com/a/status/1/video/1")).toBe(true);
    expect(handler.canHandle("https://mobile.twitter.com/a/status/1")).toBe(
      true,
    );
    expect(handler.canHandle("https://www.x.com/a/status/1")).toBe(true);
    expect(handler.canHandle("https://notx.com/a/status/1")).toBe(false);
    expect(handler.canHandle("https://youtube.com/watch?v=1")).toBe(false);
    expect(handler.canHandle("not a url")).toBe(false);
  });

  test("single video -> video result, size-capped format args", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "lttdl-x-"));
    const calls: string[][] = [];
    const { res, cleanup } = await createHandler(1, calls).download(
      "https://x.com/a/status/1/video/1",
      {},
      { tempDir, maxFileSize: 1000 },
    );
    expect(calls[0]).toContain("--no-playlist");
    expect(calls[0]).toContain("b[filesize_approx<=?1000]/b/bv*+ba");
    expect(calls[0]).toContain("--max-filesize");
    expect(res.contentType).toBe("video");
    cleanup();
    expect(readdirSync(tempDir)).toEqual([]);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("multi-video post -> ordered gallery", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "lttdl-x-"));
    const { res, cleanup } = await createHandler(3).download(
      "https://x.com/a/status/1",
      {},
      { tempDir },
    );
    expect(res.contentType).toBe("gallery");
    if (res.contentType === "gallery") {
      const paths = res.entries.map((e) =>
        e.variants[0]!.downloaded ? e.variants[0]!.path : "",
      );
      expect(paths).toEqual([...paths].sort());
      expect(paths).toHaveLength(3);
    }
    cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("no file after --max-filesize abort -> oversize error", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "lttdl-x-"));
    await expect(
      createHandler(0).download(
        "https://x.com/a/status/1",
        {},
        { tempDir, maxFileSize: 1 },
      ),
    ).rejects.toThrow("too large");
    rmSync(tempDir, { recursive: true, force: true });
  });
});
