import type { DownloadExecutionResult, DownloadOptions } from "src/dl/types";
import type { MusicSearchProviderId } from "./types";

export type MusicSearchResult = {
  id: string;
  url: string;
  title: string;
  uploader?: string;
  durationSeconds?: number;
};

export interface MusicProvider {
  readonly id: MusicSearchProviderId;

  search(query: string, limit: number): Promise<MusicSearchResult[]>;

  download(
    result: MusicSearchResult,
    options?: DownloadOptions,
  ): Promise<DownloadExecutionResult>;
}
