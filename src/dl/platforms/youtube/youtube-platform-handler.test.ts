import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { DownloadError } from "src/errors/download-error";
import { YoutubePlatformHandler } from "./youtube-platform-handler";

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lttdl-youtube-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("YoutubePlatformHandler", () => {
  test("downloads best preset as video", async () => {
    const tempDir = createTempDir();
    const handler = new YoutubePlatformHandler({
      which: () => "/usr/bin/yt-dlp",
      runCommand: async (cmd) => {
        expect(cmd).toContain("bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b");
        expect(cmd).toContain("--merge-output-format");
        expect(cmd).not.toContain("--recode-video");
        const outputArgIndex = cmd.indexOf("--output");
        const outputTemplate = cmd[outputArgIndex + 1]!;
        const finalPath = outputTemplate.replace("%(ext)s", "mp4");
        await Bun.write(finalPath, "video");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            title: "Video title",
            width: 1920,
            height: 1080,
            webpage_url: "https://youtu.be/example",
          }),
          stderr: "",
        };
      },
      getVideoResolution: async () => ({ width: 1, height: 1 }),
    });

    const result = await handler.download!(
      "https://youtu.be/example",
      { youtubePreset: "best" },
      { tempDir },
    );

    expect(result.res.contentType).toBe("video");
    if (result.res.contentType !== "video") {
      throw new Error("expected a video result");
    }
    const variant = result.res.variants[0];
    expect(variant?.downloaded).toBe(true);
    if (variant?.downloaded) {
      expect(variant.payload.resolution).toEqual({ width: 1920, height: 1080 });
      expect(variant.downloadUrl).toBe("https://youtu.be/example");
    }

    result.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("downloads best preset when yt-dlp falls back to a non-mp4 container", async () => {
    const tempDir = createTempDir();
    const handler = new YoutubePlatformHandler({
      which: () => "/usr/bin/yt-dlp",
      runCommand: async (cmd) => {
        const outputArgIndex = cmd.indexOf("--output");
        const outputTemplate = cmd[outputArgIndex + 1]!;
        const finalPath = outputTemplate.replace("%(ext)s", "webm");
        await Bun.write(finalPath, "video");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            title: "Fallback container video",
            webpage_url: "https://youtu.be/fallback",
          }),
          stderr: "",
        };
      },
      getVideoResolution: async () => ({ width: 640, height: 360 }),
    });

    const result = await handler.download!(
      "https://youtu.be/fallback",
      { youtubePreset: "best" },
      { tempDir },
    );

    expect(result.res.contentType).toBe("video");
    if (result.res.contentType !== "video") {
      throw new Error("expected a video result");
    }
    const variant = result.res.variants[0];
    expect(variant?.downloaded).toBe(true);
    if (variant?.downloaded) {
      expect(variant.path.endsWith(".webm")).toBe(true);
      expect(variant.payload.resolution).toEqual({ width: 640, height: 360 });
    }

    result.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("downloads best-audio preset as music and cleans up the file", async () => {
    const tempDir = createTempDir();
    let finalPath = "";
    const handler = new YoutubePlatformHandler({
      which: () => "/usr/bin/yt-dlp",
      runCommand: async (cmd) => {
        expect(cmd).toContain("--audio-format");
        expect(cmd).toContain("mp3");
        const outputArgIndex = cmd.indexOf("--output");
        const outputTemplate = cmd[outputArgIndex + 1]!;
        finalPath = outputTemplate.replace("%(ext)s", "mp3");
        await Bun.write(finalPath, "audio");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            title: "Audio title",
            webpage_url: "https://youtube.com/watch?v=example",
          }),
          stderr: "",
        };
      },
      getVideoResolution: async () => ({ width: 1, height: 1 }),
    });

    const result = await handler.download!(
      "https://youtube.com/watch?v=example",
      { youtubePreset: "best-audio" },
      { tempDir },
    );

    expect(result.res.contentType).toBe("music");
    if (result.res.contentType !== "music") {
      throw new Error("expected a music result");
    }
    const variant = result.res.variants[0];
    expect(variant?.downloaded).toBe(true);
    if (variant?.downloaded) {
      expect(variant.payload.name).toBe("Audio title");
      expect(variant.downloadUrl).toBe("https://youtube.com/watch?v=example");
    }
    expect(finalPath).not.toBe("");
    expect(Bun.file(finalPath).size).toBeGreaterThan(0);

    result.cleanup();
    expect(Bun.file(finalPath).size).toBe(0);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("fails clearly when yt-dlp is missing", async () => {
    const handler = new YoutubePlatformHandler({
      which: () => null,
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      getVideoResolution: async () => ({ width: 1, height: 1 }),
    });

    await expect(
      handler.download!("https://youtu.be/example", { youtubePreset: "best" }, {}),
    ).rejects.toThrow(new DownloadError("yt-dlp is not installed"));
  });
});
