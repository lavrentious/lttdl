import { Downloader as fetchTiktok } from "@tobyg74/tiktok-api-dl";
import type { TiktokAPIResponse } from "@tobyg74/tiktok-api-dl/lib/types/downloader/tiktokApiDownloader";
import type { MusicalDownResponse } from "@tobyg74/tiktok-api-dl/lib/types/downloader/musicaldownDownloader";
import type { SSSTikResponse } from "@tobyg74/tiktok-api-dl/lib/types/downloader/ssstikDownloader";
import { logger } from "src/utils/logger";
import type { ResolvedContentEntry, ResolvedVariant } from "../../types";
import type { TiktokProviderAdapter } from "./provider";
import {
  ALL_TIKTOK_PROVIDERS,
  type TiktokProvider,
  type TiktokProviderResult,
} from "./types";

function buildPrimaryEntry(
  provider: TiktokProvider,
  urls: string[],
  extras?: Partial<ResolvedVariant>,
): ResolvedContentEntry[] {
  return urls.length
    ? [
        {
          entryId: "primary",
          role: "primary",
          variants: urls.map((url) => ({
            url,
            provider,
            ...extras,
          })),
        },
      ]
    : [];
}

function buildGalleryEntries(
  provider: TiktokProvider,
  urls: string[],
): ResolvedContentEntry[] {
  return urls.map((url, index) => ({
    entryId: `image:${index}`,
    role: "gallery",
    variants: [
      {
        url,
        provider,
      },
    ],
  }));
}

export class TiktokV1Provider implements TiktokProviderAdapter {
  readonly provider = "v1";

  async resolve(url: string): Promise<TiktokProviderResult> {
    logger.debug("v1 fetching info");
    const res = await fetchTiktok(url, {
      version: "v1",
    });
    if (!res.result) {
      throw new Error(res.message || "unknown error when fetching tiktok");
    }

    return normalizeV1Response(res);
  }
}

export class TiktokV2Provider implements TiktokProviderAdapter {
  readonly provider = "v2";

  async resolve(url: string): Promise<TiktokProviderResult> {
    logger.debug("v2 fetching info");
    const res = await fetchTiktok(url, {
      version: "v2",
    });
    if (!res.result) {
      throw new Error(res.message || "unknown error when fetching tiktok");
    }

    return normalizeV2Response(res);
  }
}

export class TiktokV3Provider implements TiktokProviderAdapter {
  readonly provider = "v3";

  async resolve(url: string): Promise<TiktokProviderResult> {
    logger.debug("v3 fetching info");
    const res = await fetchTiktok(url, {
      version: "v3",
    });
    if (!res.result) {
      throw new Error(res.message || "unknown error when fetching tiktok");
    }

    return normalizeV3Response(res);
  }
}

function normalizeV1Response(res: TiktokAPIResponse): TiktokProviderResult {
  const result = res.result!;
  const kind = normalizeKind(result.type);

  return {
    provider: "v1",
    kind,
    title: kind === "audio" ? result.music?.title || null : null,
    entries: normalizeEntries("v1", kind, {
      videoUrls: result.video?.playAddr || [],
      videoDuration: result.video?.duration || undefined,
      imageUrls: result.images || [],
      audioUrls: result.music?.playUrl || [],
      audioName: result.music?.title || undefined,
    }),
  };
}

function normalizeV2Response(res: SSSTikResponse): TiktokProviderResult {
  const result = res.result!;
  const kind = normalizeKind(result.type);

  return {
    provider: "v2",
    kind,
    title: null,
    entries: normalizeEntries("v2", kind, {
      videoUrls: result.video?.playAddr || [],
      imageUrls: result.images || [],
      audioUrls: result.music?.playUrl || [],
    }),
  };
}

function normalizeV3Response(res: MusicalDownResponse): TiktokProviderResult {
  const result = res.result!;
  const kind = normalizeKind(result.type);

  return {
    provider: "v3",
    kind,
    title: null,
    entries: normalizeEntries("v3", kind, {
      videoUrls: [result.videoHD, result.videoSD].filter(
        (value): value is string => !!value,
      ),
      imageUrls: result.images || [],
      audioUrls: [result.music].filter((value): value is string => !!value),
    }),
  };
}

function normalizeKind(kind: "video" | "image" | "music"): TiktokProviderResult["kind"] {
  return kind === "music" ? "audio" : kind;
}

function normalizeEntries(
  provider: TiktokProvider,
  kind: TiktokProviderResult["kind"],
  {
    videoUrls,
    videoDuration,
    imageUrls,
    audioUrls,
    audioName,
  }: {
    videoUrls: string[];
    videoDuration?: number;
    imageUrls: string[];
    audioUrls: string[];
    audioName?: string;
  },
): ResolvedContentEntry[] {
  switch (kind) {
    case "video":
      return buildPrimaryEntry(provider, videoUrls, {
        durationSeconds: videoDuration,
      });
    case "image":
      return buildGalleryEntries(provider, imageUrls);
    case "audio":
      return buildPrimaryEntry(provider, audioUrls, {
        name: audioName,
      });
  }
}

export const TIKTOK_PROVIDER_REGISTRY = {
  v1: TiktokV1Provider,
  v2: TiktokV2Provider,
  v3: TiktokV3Provider,
} as const satisfies Record<TiktokProvider, new () => TiktokProviderAdapter>;
