import { DownloadError } from "src/errors/download-error";
import { MUSIC_PROVIDER_REGISTRY } from "./providers";
import type { MusicSearchResult } from "./provider";
import type { MusicSearchProviderId } from "./types";
import type { DownloadExecutionResult, DownloadOptions } from "src/dl/types";

function getProvider(providerId: MusicSearchProviderId) {
  const provider = MUSIC_PROVIDER_REGISTRY[providerId];
  if (!provider) {
    throw new DownloadError(`unsupported music provider: ${providerId}`);
  }

  return provider;
}

export async function searchMusic(
  providerId: MusicSearchProviderId,
  query: string,
  limit: number,
): Promise<MusicSearchResult[]> {
  return await getProvider(providerId).search(query, limit);
}

export async function downloadMusicResult(
  providerId: MusicSearchProviderId,
  result: MusicSearchResult,
  options?: DownloadOptions,
): Promise<DownloadExecutionResult> {
  return await getProvider(providerId).download(result, options);
}

export type { MusicSearchResult } from "./provider";
