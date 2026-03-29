import type { ContentKind, ResolvedContent, ResolvedContentEntry } from "src/dl/types";

export type TiktokProvider = "v1" | "v2" | "v3";
export const ALL_TIKTOK_PROVIDERS: TiktokProvider[] = ["v1", "v2", "v3"];

export type TiktokResolvedContent = Omit<ResolvedContent, "platform"> & {
  platform: "tiktok";
};

export type TiktokProviderResult = {
  provider: TiktokProvider;
  kind: ContentKind;
  title: string | null;
  entries: ResolvedContentEntry[];
};
