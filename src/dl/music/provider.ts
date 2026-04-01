import type { DownloadExecutionResult, DownloadOptions } from "src/dl/types";
import type { MusicSearchProviderId } from "./types";

export type MusicSearchResult = {
  id: string;
  url: string;
  title: string;
  uploader?: string;
  durationSeconds?: number;
};

export type MusicSearchOptions = {
  signal?: AbortSignal;
  useCookies?: boolean;
};

export interface MusicProvider {
  readonly id: MusicSearchProviderId;

  search(query: string, limit: number, options?: MusicSearchOptions): Promise<MusicSearchResult[]>;

  download(
    result: MusicSearchResult,
    options?: DownloadOptions,
  ): Promise<DownloadExecutionResult>;
}
