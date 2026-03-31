import { $, spawn } from "bun";
import { existsSync, renameSync, rmSync } from "fs";
import { config } from "./env-validation";
import { withTimeout } from "./async";
import { logger } from "./logger";

function getTypeFromBinaryData(binaryData: Uint8Array) {
  if (
    binaryData[4] === 0x66 &&
    binaryData[5] === 0x74 &&
    binaryData[6] === 0x79 &&
    binaryData[7] === 0x70
  ) {
    return "mp4";
  } else if (
    binaryData[0] === 0x46 &&
    binaryData[1] === 0x4c &&
    binaryData[2] === 0x56
  ) {
    return "flv";
  } else if (
    binaryData[0] === 0x23 &&
    binaryData[1] === 0x48 &&
    binaryData[2] === 0x54 &&
    binaryData[3] === 0x54
  ) {
    return "m3u8";
  } else if (
    binaryData[0] === 0x44 &&
    binaryData[1] === 0x44 &&
    binaryData[2] === 0x53 &&
    binaryData[3] === 0x4d
  ) {
    return "dash";
  }
}

export async function getVideoType(
  video: string | File,
): Promise<"mp4" | "flv" | "m3u8" | "dash" | undefined> {
  if (typeof video === "string") {
    return fetch(video)
      .then(async (res) => {
        const arrayBuffer = await res.arrayBuffer();
        const binaryData = new Uint8Array(arrayBuffer);
        return getTypeFromBinaryData(binaryData);
      })
      .catch(() => {
        return undefined;
      });
  } else {
    const arrayBuffer = await video.arrayBuffer();
    const binaryData = new Uint8Array(arrayBuffer);
    return getTypeFromBinaryData(binaryData);
  }
}

export async function getVideoSize(video: string | File): Promise<number> {
  if (typeof video === "string") {
    return fetch(video, { method: "HEAD" }).then((res) => {
      return parseInt(res.headers.get("Content-Length") || "0");
    });
  } else {
    return video.size;
  }
}

export async function getVideoResolution(path: string) {
  const ffprobeTimeoutMs = config.get("VIDEO_FFPROBE_TIMEOUT_MS");
  const output = await withTimeout(
    $`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json ${path}`.text(),
    ffprobeTimeoutMs,
    "ffprobe",
  );
  const info = JSON.parse(output);
  const stream = info.streams?.[0];
  return { width: +stream.width, height: +stream.height };
}

export async function getVideoMetadata(path: string): Promise<{
  width: number;
  height: number;
  durationSeconds?: number;
}> {
  const ffprobeTimeoutMs = config.get("VIDEO_FFPROBE_TIMEOUT_MS");
  const output = await withTimeout(
    $`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration -show_entries format=duration -of json ${path}`.text(),
    ffprobeTimeoutMs,
    "ffprobe",
  );
  const info = JSON.parse(output);
  const stream = info.streams?.[0];
  const durationValue = stream?.duration ?? info.format?.duration;
  const durationSeconds =
    typeof durationValue === "string" || typeof durationValue === "number"
      ? Math.max(Math.round(Number(durationValue)), 0)
      : undefined;

  return {
    width: +stream.width,
    height: +stream.height,
    durationSeconds:
      durationSeconds !== undefined && Number.isFinite(durationSeconds)
        ? durationSeconds
        : undefined,
  };
}

export async function getAudioDuration(path: string): Promise<number | undefined> {
  const ffprobeTimeoutMs = config.get("VIDEO_FFPROBE_TIMEOUT_MS");
  const output = await withTimeout(
    $`ffprobe -v error -show_entries format=duration -of json ${path}`.text(),
    ffprobeTimeoutMs,
    "ffprobe",
  );
  const info = JSON.parse(output);
  const durationValue = info.format?.duration;
  const durationSeconds =
    typeof durationValue === "string" || typeof durationValue === "number"
      ? Math.max(Math.round(Number(durationValue)), 0)
      : undefined;

  return durationSeconds !== undefined && Number.isFinite(durationSeconds)
    ? durationSeconds
    : undefined;
}

type AudioTagOptions = {
  title?: string;
  artist?: string;
  album?: string;
  coverPath?: string;
};

export async function isMp4File(path: string): Promise<boolean> {
  const header = new Uint8Array(await Bun.file(path).slice(0, 12).arrayBuffer());
  return getTypeFromBinaryData(header) === "mp4";
}

async function runFfmpeg(args: string[], label: string): Promise<void> {
  const ffmpegPath = Bun.which("ffmpeg");
  const ffmpegTimeoutMs = config.get("VIDEO_FFMPEG_TIMEOUT_MS");
  if (!ffmpegPath) {
    throw new Error("ffmpeg is not installed");
  }

  const process = spawn({
    cmd: [ffmpegPath, ...args],
    stdout: "ignore",
    stderr: "pipe",
  });

  const [exitCode, stderr] = await withTimeout(
    Promise.all([process.exited, new Response(process.stderr).text()]),
    ffmpegTimeoutMs,
    label,
  );

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `${label} failed`);
  }
}

export async function writeMp3Metadata(
  inputPath: string,
  outputPath: string,
  options: AudioTagOptions,
): Promise<void> {
  if (existsSync(outputPath)) {
    rmSync(outputPath);
  }

  const args = [
    "-y",
    "-i",
    inputPath,
    ...(options.coverPath ? ["-i", options.coverPath] : []),
    "-map",
    "0:a:0",
    ...(options.coverPath ? ["-map", "1:v:0"] : []),
    "-c:a",
    "copy",
    ...(options.coverPath ? ["-c:v", "mjpeg"] : []),
    "-id3v2_version",
    "3",
    ...(options.title ? ["-metadata", `title=${options.title}`] : []),
    ...(options.artist ? ["-metadata", `artist=${options.artist}`] : []),
    ...(options.album ? ["-metadata", `album=${options.album}`] : []),
    ...(options.coverPath
      ? [
          "-metadata:s:v",
          "title=Album cover",
          "-metadata:s:v",
          "comment=Cover (front)",
        ]
      : []),
    outputPath,
  ];

  await runFfmpeg(args, "ffmpeg audio metadata");
}

export async function ensureMp4Video(inputPath: string, outputPath: string): Promise<void> {
  if (existsSync(outputPath)) {
    rmSync(outputPath);
  }

  try {
    await runFfmpeg(
      [
        "-y",
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      "ffmpeg remux",
    );
    return;
  } catch (error) {
    logger.warn(
      `failed to remux video to mp4, retrying with re-encode: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    if (existsSync(outputPath)) {
      rmSync(outputPath);
    }
  }

  await runFfmpeg(
    [
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    "ffmpeg re-encode",
  );
}

export function moveFile(sourcePath: string, targetPath: string): void {
  if (sourcePath === targetPath) {
    return;
  }

  if (existsSync(targetPath)) {
    rmSync(targetPath);
  }

  renameSync(sourcePath, targetPath);
}
