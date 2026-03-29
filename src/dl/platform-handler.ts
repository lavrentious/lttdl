import type { Platform, ResolvedContent } from "./types";

export type ResolveContext = {
  tiktokProviders?: string[];
};

export interface PlatformHandler {
  readonly platform: Platform;

  canHandle(url: string): boolean;

  resolve(url: string, context?: ResolveContext): Promise<ResolvedContent>;
}
