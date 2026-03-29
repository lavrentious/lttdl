import type { YoutubePreset } from "../../types";

export const ALL_YOUTUBE_PRESETS: YoutubePreset[] = [
  "best",
  "fast-1080",
  "fast-720",
  "best-audio",
  "mid-audio",
];

export const YOUTUBE_PRESET_LABELS: Record<YoutubePreset, string> = {
  best: "best",
  "fast-1080": "fast 1080p",
  "fast-720": "fast 720p",
  "best-audio": "best audio",
  "mid-audio": "mid audio",
};

export const YOUTUBE_PRESET_DESCRIPTIONS: Record<YoutubePreset, string> = {
  best:
    "`best` - highest quality video with audio, prefers mp4-compatible downloads and avoids slow recoding when possible.",
  "fast-1080":
    "`fast 1080p` - prefers already-compatible mp4/h264 paths up to 1080p for quicker downloads and easier Telegram playback.",
  "fast-720":
    "`fast 720p` - same fast-path idea, capped at 720p for smaller files and faster delivery.",
  "best-audio":
    "`best audio` - best audio-only output, converted to mp3.",
  "mid-audio":
    "`mid audio` - smaller audio-only mp3 preset, aims for moderate bitrate to save bandwidth and upload size.",
};
