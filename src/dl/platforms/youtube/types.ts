import type { YoutubePreset } from "../../types";

export const DEFAULT_YOUTUBE_PRESET: YoutubePreset = "auto-video-audio";

export const ALL_YOUTUBE_PRESETS: YoutubePreset[] = [
  "auto-video-audio",
  "auto-audio-only",
  "best",
  "fast-1080",
  "fast-720",
  "best-audio",
  "mid-audio",
];

export const YOUTUBE_PRESET_LABELS: Record<YoutubePreset, string> = {
  "auto-video-audio": "auto video+audio",
  "auto-audio-only": "auto audio only",
  best: "best",
  "fast-1080": "fast 1080p",
  "fast-720": "fast 720p",
  "best-audio": "best audio",
  "mid-audio": "mid audio",
};

export const YOUTUBE_PRESET_DESCRIPTIONS: Record<YoutubePreset, string> = {
  "auto-video-audio":
    "`auto video+audio` - picks the best youtube video format with audio that is likely to stay under the bot upload limit.",
  "auto-audio-only":
    "`auto audio only` - picks the best youtube audio-only format that is likely to stay under the bot upload limit and converts it to mp3.",
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
