export const ALL_MUSIC_SEARCH_PROVIDERS = ["youtube-music", "youtube"] as const;

export type MusicSearchProviderId = (typeof ALL_MUSIC_SEARCH_PROVIDERS)[number];

export const DEFAULT_MUSIC_SEARCH_PROVIDER: MusicSearchProviderId = "youtube-music";

export const MUSIC_SEARCH_PROVIDER_LABELS: Record<MusicSearchProviderId, string> = {
  "youtube-music": "youtube music",
  youtube: "youtube videos",
};

export const MUSIC_SEARCH_PROVIDER_DESCRIPTIONS: Record<
  MusicSearchProviderId,
  string
> = {
  "youtube-music":
    "`youtube music` - searches the YouTube Music songs section via `yt-dlp` and downloads the selected track as mp3.",
  youtube:
    "`youtube videos` - searches regular YouTube video results via `yt-dlp` and downloads the selected result as mp3.",
};
