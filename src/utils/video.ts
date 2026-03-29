import { $, spawn } from "bun";
import { existsSync, rmSync } from "fs";
import { withTimeout } from "./async";
import { logger } from "./logger";

const FFPROBE_TIMEOUT_MS = 15000;
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

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
  const output = await withTimeout(
    $`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json ${path}`.text(),
    FFPROBE_TIMEOUT_MS,
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
  const output = await withTimeout(
    $`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration -show_entries format=duration -of json ${path}`.text(),
    FFPROBE_TIMEOUT_MS,
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
  const output = await withTimeout(
    $`ffprobe -v error -show_entries format=duration -of json ${path}`.text(),
    FFPROBE_TIMEOUT_MS,
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

async function runFfmpeg(args: string[], label: string): Promise<void> {
  const ffmpegPath = Bun.which("ffmpeg");
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
    FFMPEG_TIMEOUT_MS,
    label,
  );

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `${label} failed`);
  }
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
