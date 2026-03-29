import type { YoutubePreset } from "../../types";

export const ALL_YOUTUBE_PRESETS: YoutubePreset[] = ["best", "best-audio"];

export const YOUTUBE_PRESET_LABELS: Record<YoutubePreset, string> = {
  best: "best",
  "best-audio": "best audio",
};
