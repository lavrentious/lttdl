import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { DownloadError } from "src/errors/download-error";
import { YoutubeMusicProvider } from "./youtube-music-provider";

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lttdl-music-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("YoutubeMusicProvider", () => {
  test("searches youtube music songs and returns normalized results", async () => {
    let searchArg = "";
    let executedCommand: string[] = [];
    const provider = new YoutubeMusicProvider({
      id: "youtube-music",
      searchMode: "music",
    }, {
      which: () => "/usr/bin/yt-dlp",
      runCommand: async (cmd) => {
        executedCommand = cmd;
        searchArg = cmd.at(-1) || "";
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            entries: [
              {
                id: "track-1",
                title: "Track 1",
                artists: ["Artist 1"],
                duration_string: "3:01",
              },
              {
                id: "track-2",
                title: "Track 2",
                artists: ["Artist 2", "Artist 3"],
                duration: 205,
                webpage_url: "https://www.youtube.com/watch?v=track-2",
              },
            ],
          }),
          stderr: "",
        };
      },
    });

    const results = await provider.search("daft punk", 5);

    expect(executedCommand).not.toContain("--flat-playlist");
    expect(executedCommand).toContain("--playlist-items");
    expect(executedCommand).toContain("1:5");
    expect(searchArg).toBe("https://music.youtube.com/search?q=daft%20punk#songs");
    expect(results).toEqual([
      {
        id: "track-1",
        url: "https://www.youtube.com/watch?v=track-1",
        title: "Track 1",
        uploader: "Artist 1",
        durationSeconds: 181,
      },
      {
        id: "track-2",
        url: "https://www.youtube.com/watch?v=track-2",
        title: "Track 2",
        uploader: "Artist 2, Artist 3",
        durationSeconds: 205,
      },
    ]);
  });

  test("searches regular youtube videos when configured", async () => {
    let searchArg = "";
    const provider = new YoutubeMusicProvider({
      id: "youtube",
      searchMode: "youtube",
    }, {
      which: () => "/usr/bin/yt-dlp",
      runCommand: async (cmd) => {
        searchArg = cmd.at(-1) || "";
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            entries: [
              {
                id: "video-1",
                title: "Video 1",
                uploader: "Artist 1",
                duration: 181,
              },
            ],
          }),
          stderr: "",
        };
      },
    });

    const results = await provider.search("daft punk", 5);

    expect(searchArg).toBe("ytsearch5:daft punk");
    expect(results).toEqual([
      {
        id: "video-1",
        url: "https://www.youtube.com/watch?v=video-1",
        title: "Video 1",
        uploader: "Artist 1",
        durationSeconds: 181,
      },
    ]);
  });

  test("downloads selected result as mp3 with metadata and thumbnail embedding", async () => {
    const tempDir = createTempDir();
    const progressStages: string[] = [];
    let executedCommand: string[] = [];
    const provider = new YoutubeMusicProvider({
      id: "youtube-music",
      searchMode: "music",
    }, {
      which: () => "/usr/bin/yt-dlp",
      runCommand: async (cmd, hooks) => {
        executedCommand = cmd;
        await hooks?.onStdoutLine?.("[download]  50.0% of 10.00MiB at 5.00MiB/s ETA 00:01");
        await hooks?.onStdoutLine?.("[ExtractAudio] Destination: song.mp3");
        const outputArgIndex = cmd.indexOf("--output");
        const outputTemplate = cmd[outputArgIndex + 1]!;
        const finalPath = outputTemplate.replace("%(ext)s", "mp3");
        await Bun.write(finalPath, "audio");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            title: "Song title",
            duration: 222,
            webpage_url: "https://www.youtube.com/watch?v=song",
          }),
          stderr: "",
        };
      },
    });

    const result = await provider.download(
      {
        id: "song",
        url: "https://www.youtube.com/watch?v=song",
        title: "Song title",
      },
      {
        tempDir,
        onProgress: (progress) => {
          progressStages.push(progress.stage);
        },
      },
    );

    expect(executedCommand).toContain("--extract-audio");
    expect(executedCommand).toContain("--audio-format");
    expect(executedCommand).toContain("mp3");
    expect(executedCommand).toContain("--audio-quality");
    expect(executedCommand).toContain("0");
    expect(executedCommand).toContain("--concurrent-fragments");
    expect(executedCommand).toContain("4");
    expect(executedCommand).toContain("--add-metadata");
    expect(executedCommand).toContain("--embed-thumbnail");
    expect(result.res.contentType).toBe("music");
    expect(progressStages).toEqual(["download", "completed"]);

    result.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("ignores destination postprocess noise in progress updates", async () => {
    const tempDir = createTempDir();
    const progressMessages: string[] = [];
    const provider = new YoutubeMusicProvider({
      id: "youtube-music",
      searchMode: "music",
    }, {
      which: () => "/usr/bin/yt-dlp",
      runCommand: async (cmd, hooks) => {
        await hooks?.onStdoutLine?.("[ExtractAudio] Destination: /tmp/song.mp3");
        await hooks?.onStdoutLine?.("[ExtractAudio] Extracting audio");
        const outputArgIndex = cmd.indexOf("--output");
        const outputTemplate = cmd[outputArgIndex + 1]!;
        const finalPath = outputTemplate.replace("%(ext)s", "mp3");
        await Bun.write(finalPath, "audio");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            title: "Song title",
            duration: 222,
            webpage_url: "https://www.youtube.com/watch?v=song",
          }),
          stderr: "",
        };
      },
    });

    await provider.download(
      {
        id: "song",
        url: "https://www.youtube.com/watch?v=song",
        title: "Song title",
      },
      {
        tempDir,
        onProgress: (progress) => {
          if (progress.stage === "postprocess") {
            progressMessages.push(progress.message);
          }
        },
      },
    );

    expect(progressMessages).toEqual(["extracting audio..."]);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("fails clearly when yt-dlp is missing", async () => {
    const provider = new YoutubeMusicProvider({
      id: "youtube-music",
      searchMode: "music",
    }, {
      which: () => null,
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    await expect(provider.search("song", 5)).rejects.toThrow(
      new DownloadError("yt-dlp is not installed"),
    );
  });
});
