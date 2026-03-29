import { DownloadError } from "src/errors/download-error";
import { retryAsync, withTimeout } from "src/utils/async";
import { isRetryableNetworkError } from "src/dl/asset-downloader";
import type { PlatformHandler, ResolveContext } from "../../platform-handler";
import type { ContentKind, ResolvedContentEntry, ResolvedVariant } from "../../types";
import type { TiktokProviderAdapter } from "./provider";
import { TIKTOK_PROVIDER_REGISTRY } from "./providers";
import {
  ALL_TIKTOK_PROVIDERS,
  type TiktokProvider,
  type TiktokProviderResult,
  type TiktokResolvedContent,
} from "./types";

const FETCH_INFO_TIMEOUT_MS = 15000;
const FETCH_INFO_RETRIES = 1;
const RETRY_DELAY_MS = 300;

function dedupeVariants(variants: ResolvedVariant[]): ResolvedVariant[] {
  const seen = new Set<string>();
  const deduped: ResolvedVariant[] = [];

  for (const variant of variants) {
    const key = `${variant.provider}:${variant.url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(variant);
  }

  return deduped;
}

function pickDominantKind(results: TiktokProviderResult[]): ContentKind {
  const counts = new Map<ContentKind, number>();

  for (const result of results) {
    counts.set(result.kind, (counts.get(result.kind) || 0) + 1);
  }

  let bestKind: ContentKind | null = null;
  let bestCount = -1;
  for (const result of results) {
    const count = counts.get(result.kind) || 0;
    if (count > bestCount) {
      bestKind = result.kind;
      bestCount = count;
    }
  }

  if (!bestKind) {
    throw new DownloadError("could not detect content type");
  }

  return bestKind;
}

function mergeEntriesById(results: TiktokProviderResult[]): ResolvedContentEntry[] {
  const order: string[] = [];
  const merged = new Map<string, ResolvedContentEntry>();

  for (const result of results) {
    for (const entry of result.entries) {
      if (!merged.has(entry.entryId)) {
        order.push(entry.entryId);
        merged.set(entry.entryId, {
          entryId: entry.entryId,
          role: entry.role,
          variants: [],
        });
      }

      merged.get(entry.entryId)!.variants.push(...entry.variants);
    }
  }

  return order
    .map((entryId) => merged.get(entryId)!)
    .map((entry) => ({
      ...entry,
      variants: dedupeVariants(entry.variants),
    }))
    .filter((entry) => entry.variants.length > 0);
}

export function reconcileTiktokResults(
  results: TiktokProviderResult[],
): TiktokResolvedContent {
  if (!results.length) {
    throw new DownloadError("all tiktok providers failed");
  }

  const kind = pickDominantKind(results);
  const compatible = results.filter((result) => result.kind === kind);
  const title = compatible.map((result) => result.title).find((value) => !!value) || null;
  const entries = mergeEntriesById(compatible);

  if (!entries.length) {
    throw new DownloadError("could not get download links");
  }

  return {
    platform: "tiktok",
    kind,
    title,
    entries,
  };
}

export class TiktokPlatformHandler implements PlatformHandler {
  readonly platform = "tiktok" as const;

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return (
        hostname.includes("tiktok.com") ||
        hostname === "vm.tiktok.com" ||
        hostname === "vt.tiktok.com"
      );
    } catch {
      return false;
    }
  }

  async resolve(
    url: string,
    context?: ResolveContext,
  ): Promise<TiktokResolvedContent> {
    const requestedProviders = context?.tiktokProviders?.filter(
      (provider): provider is TiktokProvider =>
        ALL_TIKTOK_PROVIDERS.includes(provider as TiktokProvider),
    );
    const providerIds = requestedProviders?.length
      ? Array.from(new Set(requestedProviders))
      : ALL_TIKTOK_PROVIDERS;
    const adapters = providerIds.map((providerId) => {
      const Provider = TIKTOK_PROVIDER_REGISTRY[providerId];
      return new Provider();
    });
    const settled = await Promise.allSettled(
      adapters.map(async (adapter) => await resolveWithRetry(adapter, url)),
    );
    const results = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );

    return reconcileTiktokResults(results);
  }
}

async function resolveWithRetry(
  adapter: TiktokProviderAdapter,
  url: string,
): Promise<TiktokProviderResult> {
  return await retryAsync(
    async () =>
      await withTimeout(
        adapter.resolve(url),
        FETCH_INFO_TIMEOUT_MS,
        `${adapter.provider} resolve`,
      ),
    {
      retries: FETCH_INFO_RETRIES,
      delayMs: RETRY_DELAY_MS,
      shouldRetry: isRetryableNetworkError,
    },
  );
}
