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
      finalizeAudioFile: async () => {},
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

  test("falls back to channel name when artist metadata is missing", async () => {
    const provider = new YoutubeMusicProvider({
      id: "youtube-music",
      searchMode: "music",
    }, {
      which: () => "/usr/bin/yt-dlp",
      finalizeAudioFile: async () => {},
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          entries: [
            {
              id: "track-1",
              title: "Track 1",
              channel: "Kid Cudi",
              duration_string: "4:18",
            },
          ],
        }),
        stderr: "",
      }),
    });

    const results = await provider.search("kid cudi mr rager", 5);

    expect(results).toEqual([
      {
        id: "track-1",
        url: "https://www.youtube.com/watch?v=track-1",
        title: "Track 1",
        uploader: "Kid Cudi",
        durationSeconds: 258,
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
      finalizeAudioFile: async () => {},
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
    let runCount = 0;
    let finalizeArgs:
      | {
          inputPath: string;
          outputPath: string;
          options: {
            title?: string;
            artist?: string;
            album?: string;
            coverPath?: string;
          };
        }
      | undefined;
    const provider = new YoutubeMusicProvider({
      id: "youtube-music",
      searchMode: "music",
    }, {
      which: () => "/usr/bin/yt-dlp",
      finalizeAudioFile: async (inputPath, outputPath, options) => {
        finalizeArgs = { inputPath, outputPath, options };
        await Bun.write(outputPath, await Bun.file(inputPath).bytes());
      },
      runCommand: async (cmd, hooks) => {
        runCount += 1;
        executedCommand = cmd;
        if (cmd.includes("--dump-single-json")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              title: "Song title",
              track: "Mr. Rager",
              artist: "",
              channel: "Kid Cudi",
              album: "Man on the Moon II",
              duration: 222,
              webpage_url: "https://www.youtube.com/watch?v=song",
            }),
            stderr: "",
          };
        }
        await hooks?.onStdoutLine?.("[download]  50.0% of 10.00MiB at 5.00MiB/s ETA 00:01");
        await hooks?.onStdoutLine?.("[ExtractAudio] Destination: song.mp3");
        const outputArgIndex = cmd.indexOf("--output");
        if (outputArgIndex >= 0) {
          const outputTemplate = cmd[outputArgIndex + 1]!;
          const finalPath = outputTemplate.replace("%(ext)s", "mp3");
          await Bun.write(finalPath, "audio");
        }
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
    expect(executedCommand).toContain("-f");
    expect(executedCommand).toContain("ba");
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
    expect(runCount).toBe(2);
    if (result.res.contentType === "music") {
      expect(result.res.variants[0]?.downloaded).toBe(true);
      if (result.res.variants[0]?.downloaded) {
        expect(result.res.variants[0].payload.name).toBe("Mr. Rager");
        expect(result.res.variants[0].payload.filename).toBe("Mr. Rager.mp3");
        expect(result.res.variants[0].payload.performer).toBe("Kid Cudi");
        expect(result.res.variants[0].payload.details).toBe("Man on the Moon II");
      }
    }
    expect(finalizeArgs).toBeDefined();
    expect(finalizeArgs?.options).toEqual({
      title: "Mr. Rager",
      artist: "Kid Cudi",
      album: "Man on the Moon II",
      coverPath: undefined,
    });

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
      finalizeAudioFile: async (inputPath, outputPath) => {
        await Bun.write(outputPath, await Bun.file(inputPath).bytes());
      },
      runCommand: async (cmd, hooks) => {
        await hooks?.onStdoutLine?.("[ExtractAudio] Destination: /tmp/song.mp3");
        await hooks?.onStdoutLine?.("[ExtractAudio] Extracting audio");
        const outputArgIndex = cmd.indexOf("--output");
        if (outputArgIndex >= 0) {
          const outputTemplate = cmd[outputArgIndex + 1]!;
          const finalPath = outputTemplate.replace("%(ext)s", "mp3");
          await Bun.write(finalPath, "audio");
        }
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

  test("chooses the best audio-only format that fits under max file size", async () => {
    const tempDir = createTempDir();
    let downloadCommand: string[] = [];
    const provider = new YoutubeMusicProvider({
      id: "youtube-music",
      searchMode: "music",
    }, {
      which: () => "/usr/bin/yt-dlp",
      finalizeAudioFile: async (inputPath, outputPath) => {
        await Bun.write(outputPath, await Bun.file(inputPath).bytes());
      },
      runCommand: async (cmd) => {
        if (cmd.includes("--dump-single-json")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              title: "Song title",
              duration: 200,
              formats: [
                {
                  format_id: "tiny",
                  acodec: "mp4a.40.2",
                  vcodec: "none",
                  abr: 96,
                  ext: "m4a",
                },
                {
                  format_id: "fit",
                  acodec: "mp4a.40.2",
                  vcodec: "none",
                  abr: 192,
                  ext: "m4a",
                },
                {
                  format_id: "too-big",
                  acodec: "mp4a.40.2",
                  vcodec: "none",
                  abr: 3200,
                  ext: "m4a",
                },
              ],
            }),
            stderr: "",
          };
        }

        downloadCommand = cmd;
        const outputArgIndex = cmd.indexOf("--output");
        if (outputArgIndex >= 0) {
          const outputTemplate = cmd[outputArgIndex + 1]!;
          const finalPath = outputTemplate.replace("%(ext)s", "mp3");
          await Bun.write(finalPath, "audio");
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({}),
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
        maxFileSize: 5 * 1024 * 1024,
      },
    );

    expect(downloadCommand).toContain("-f");
    expect(downloadCommand).toContain("fit");
    expect(downloadCommand).not.toContain("too-big");
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("prefers higher bitrate even when only tbr is reported", async () => {
    const tempDir = createTempDir();
    let downloadCommand: string[] = [];
    const provider = new YoutubeMusicProvider({
      id: "youtube-music",
      searchMode: "music",
    }, {
      which: () => "/usr/bin/yt-dlp",
      finalizeAudioFile: async (inputPath, outputPath) => {
        await Bun.write(outputPath, await Bun.file(inputPath).bytes());
      },
      runCommand: async (cmd) => {
        if (cmd.includes("--dump-single-json")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              title: "Song title",
              duration: 240,
              formats: [
                {
                  format_id: "m4a-low",
                  acodec: "mp4a.40.2",
                  vcodec: "none",
                  abr: 128,
                  ext: "m4a",
                },
                {
                  format_id: "webm-high",
                  acodec: "opus",
                  vcodec: "none",
                  tbr: 275,
                  ext: "webm",
                },
              ],
            }),
            stderr: "",
          };
        }

        downloadCommand = cmd;
        const outputArgIndex = cmd.indexOf("--output");
        if (outputArgIndex >= 0) {
          const outputTemplate = cmd[outputArgIndex + 1]!;
          const finalPath = outputTemplate.replace("%(ext)s", "mp3");
          await Bun.write(finalPath, "audio");
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({}),
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
        maxFileSize: 50 * 1024 * 1024,
      },
    );

    expect(downloadCommand).toContain("-f");
    expect(downloadCommand).toContain("webm-high");
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("prefers opus audio-only over slightly higher bitrate aac for mp3 extraction", async () => {
    const tempDir = createTempDir();
    let downloadCommand: string[] = [];
    const provider = new YoutubeMusicProvider({
      id: "youtube-music",
      searchMode: "music",
    }, {
      which: () => "/usr/bin/yt-dlp",
      finalizeAudioFile: async (inputPath, outputPath) => {
        await Bun.write(outputPath, await Bun.file(inputPath).bytes());
      },
      runCommand: async (cmd) => {
        if (cmd.includes("--dump-single-json")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              title: "Song title",
              duration: 269,
              formats: [
                {
                  format_id: "140",
                  acodec: "mp4a.40.2",
                  vcodec: "none",
                  abr: 129.57,
                  tbr: 129.57,
                  ext: "m4a",
                },
                {
                  format_id: "251",
                  acodec: "opus",
                  vcodec: "none",
                  abr: 127.512,
                  tbr: 127.512,
                  ext: "webm",
                },
              ],
            }),
            stderr: "",
          };
        }

        downloadCommand = cmd;
        const outputArgIndex = cmd.indexOf("--output");
        if (outputArgIndex >= 0) {
          const outputTemplate = cmd[outputArgIndex + 1]!;
          const finalPath = outputTemplate.replace("%(ext)s", "mp3");
          await Bun.write(finalPath, "audio");
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({}),
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
        maxFileSize: 50 * 1024 * 1024,
      },
    );

    expect(downloadCommand).toContain("-f");
    expect(downloadCommand).toContain("251");
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("considers progressive formats when they expose a higher audio bitrate", async () => {
    const tempDir = createTempDir();
    let downloadCommand: string[] = [];
    const provider = new YoutubeMusicProvider({
      id: "youtube-music",
      searchMode: "music",
    }, {
      which: () => "/usr/bin/yt-dlp",
      finalizeAudioFile: async (inputPath, outputPath) => {
        await Bun.write(outputPath, await Bun.file(inputPath).bytes());
      },
      runCommand: async (cmd) => {
        if (cmd.includes("--dump-single-json")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              title: "Song title",
              duration: 180,
              formats: [
                {
                  format_id: "251",
                  acodec: "opus",
                  vcodec: "none",
                  abr: 128,
                  tbr: 128,
                  ext: "webm",
                },
                {
                  format_id: "18",
                  acodec: "aac",
                  vcodec: "h264",
                  abr: 192,
                  tbr: 400,
                  ext: "mp4",
                },
              ],
            }),
            stderr: "",
          };
        }

        downloadCommand = cmd;
        const outputArgIndex = cmd.indexOf("--output");
        if (outputArgIndex >= 0) {
          const outputTemplate = cmd[outputArgIndex + 1]!;
          const finalPath = outputTemplate.replace("%(ext)s", "mp3");
          await Bun.write(finalPath, "audio");
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({}),
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
        maxFileSize: 50 * 1024 * 1024,
      },
    );

    expect(downloadCommand).toContain("-f");
    expect(downloadCommand).toContain("18");
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("fails early when no audio format can fit under max file size", async () => {
    const tempDir = createTempDir();
    const provider = new YoutubeMusicProvider({
      id: "youtube-music",
      searchMode: "music",
    }, {
      which: () => "/usr/bin/yt-dlp",
      finalizeAudioFile: async () => {},
      runCommand: async (cmd) => {
        if (cmd.includes("--dump-single-json")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              title: "Song title",
              duration: 300,
              formats: [
                {
                  format_id: "huge",
                  acodec: "mp4a.40.2",
                  vcodec: "none",
                  abr: 5000,
                  ext: "m4a",
                },
              ],
            }),
            stderr: "",
          };
        }

        return {
          exitCode: 0,
          stdout: JSON.stringify({}),
          stderr: "",
        };
      },
    });

    await expect(
      provider.download(
        {
          id: "song",
          url: "https://www.youtube.com/watch?v=song",
          title: "Song title",
        },
        {
          tempDir,
          maxFileSize: 1024 * 1024,
        },
      ),
    ).rejects.toThrow(new DownloadError("audio is likely too large to upload"));

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("fails clearly when yt-dlp is missing", async () => {
    const provider = new YoutubeMusicProvider({
      id: "youtube-music",
      searchMode: "music",
    }, {
      which: () => null,
      finalizeAudioFile: async () => {},
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    await expect(provider.search("song", 5)).rejects.toThrow(
      new DownloadError("yt-dlp is not installed"),
    );
  });
});
