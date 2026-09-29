import type { DownloadExecutionResult, DownloadOptions } from "src/dl/types";
import { DownloadError, toDownloadError } from "src/errors/download-error";
import type { MusicSearchOptions, MusicSearchResult } from "./provider";
import { MUSIC_PROVIDER_REGISTRY } from "./providers";
import type { MusicSearchProviderId } from "./types";

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
  options?: MusicSearchOptions,
): Promise<MusicSearchResult[]> {
  try {
    return await getProvider(providerId).search(query, limit, options);
  } catch (error) {
    throw toDownloadError(error);
  }
}

export async function downloadMusicResult(
  providerId: MusicSearchProviderId,
  result: MusicSearchResult,
  options?: DownloadOptions,
): Promise<DownloadExecutionResult> {
  try {
    return await getProvider(providerId).download(result, options);
  } catch (error) {
    throw toDownloadError(error);
  }
}

export type { MusicSearchResult } from "./provider";
