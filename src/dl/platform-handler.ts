import type {
  DownloadExecutionResult,
  DownloadOptions,
  Platform,
  ResolvedContent,
  YoutubePreset,
} from "./types";

export type ResolveContext = {
  tiktokProviders?: string[];
  youtubePreset?: YoutubePreset;
};

export interface PlatformHandler {
  readonly platform: Platform;

  canHandle(url: string): boolean;

  resolve?(url: string, context?: ResolveContext): Promise<ResolvedContent>;

  download?(
    url: string,
    context?: ResolveContext,
    options?: DownloadOptions,
  ): Promise<DownloadExecutionResult>;
}
