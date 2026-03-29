export type Platform = "tiktok" | "youtube" | "pinterest";
export type YoutubePreset = "best" | "best-audio";

export type ContentKind = "video" | "image" | "audio";

export type ResolvedVariant = {
  url: string;
  provider: string;
  format?: string;
  qualityLabel?: string;
  width?: number;
  height?: number;
  name?: string;
};

export type ResolvedContentEntry = {
  entryId: string;
  role: "primary" | "gallery";
  variants: ResolvedVariant[];
};

export type ResolvedContent = {
  platform: Platform;
  kind: ContentKind;
  title: string | null;
  entries: ResolvedContentEntry[];
};

export type ContentVariant<T> = {
  downloadUrl: string;
  cleanup?: () => void;
} & (
  | {
      downloaded: false;
    }
  | {
      downloaded: true;
      path: string;
      size: number;
      payload: T;
    }
);

export type VideoVariant = ContentVariant<{
  resolution: { width: number; height: number };
}>;

export type PhotoVariant = ContentVariant<{
  resolution: { width: number; height: number };
}>;

export type MusicVariant = ContentVariant<{
  name?: string;
}>;

export type DownloadResult =
  | {
      contentType: "video";
      variants: VideoVariant[];
    }
  | {
      contentType: "image";
      variants: PhotoVariant[][];
    }
  | {
      contentType: "music";
      variants: MusicVariant[];
    };

export type DownloadStrategy = "all" | "single";

export type DownloadOptions = {
  tempDir?: string;
  strategy?: DownloadStrategy;
  maxFileSize?: number;
};

export type DownloadExecutionResult = {
  res: DownloadResult;
  cleanup: () => void;
};
