import type { TiktokProviderResult } from "./types";

export interface TiktokProviderAdapter {
  readonly provider: string;

  resolve(url: string): Promise<TiktokProviderResult>;
}
