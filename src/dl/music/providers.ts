import { YoutubeMusicProvider } from "./providers/youtube-music-provider";
import type { MusicProvider } from "./provider";
import type { MusicSearchProviderId } from "./types";

export const MUSIC_PROVIDER_REGISTRY: Record<MusicSearchProviderId, MusicProvider> = {
  "youtube-music": new YoutubeMusicProvider(),
};

