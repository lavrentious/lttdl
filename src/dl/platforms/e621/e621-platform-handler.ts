import { DownloadError } from "src/errors/download-error";
import {
  mapWithConcurrency,
  retryAsync,
  throwIfAborted,
  withTimeout,
} from "src/utils/async";
import { config } from "src/utils/env-validation";
import { logger } from "src/utils/logger";
import {
  AssetDownloader,
  isRetryableNetworkError,
} from "../../asset-downloader";
import { AssetProcessor } from "../../asset-processor";
import type { PlatformHandler } from "../../platform-handler";
import type {
  ContentRating,
  DownloadExecutionResult,
  DownloadOptions,
  GalleryEntry,
  PhotoVariant,
  ResolvedVariant,
  VideoVariant,
} from "../../types";

// e926.net sits behind a cloudflare challenge for api clients, and is just
// e621 restricted to rating:s - so always query e621 and filter for e926 links
const API_BASE = "https://e621.net";
const STATIC_BASE = "https://static1.e621.net/data";
// e621 requires a descriptive user agent and blocks browser-like ones
const API_USER_AGENT = "media-downloader/1.0";
const HOSTNAME = /^(?:www\.)?(e621|e926)\.net$/;
const POOL_PATH = /^\/pools\/(\d+)(?:\.json)?\/?$/;
const MAX_POOL_ITEMS = 100;
const POST_ID_BATCH_SIZE = 100;
const DOWNLOAD_CONCURRENCY = 4;
// telegram rejects photos with width + height > 10000; it shrinks past 2560 anyway
const MAX_IMAGE_SIDE = 4096;
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm"]);
const VIDEO_SAMPLE_KEYS = ["720p", "480p"];

type E621Pool = {
  id: number;
  name?: string;
  post_ids: number[];
};

type E621VideoSource = {
  url: string | null;
  size?: number;
  width?: number;
  height?: number;
};

export type E621Post = {
  id: number;
  rating: string;
  file: {
    width: number;
    height: number;
    ext: string;
    size: number;
    md5: string;
    url: string | null;
  };
  sample?: {
    alternates?: {
      variants?: Record<string, E621VideoSource | undefined>;
      samples?: Record<string, E621VideoSource | undefined>;
    };
  };
  flags?: {
    deleted?: boolean;
  };
};

type JsonResponse = {
  status: number;
  data: unknown;
};

type E621HandlerDeps = {
  fetchJson: (url: string, signal?: AbortSignal) => Promise<JsonResponse>;
  downloadImage: (
    variant: ResolvedVariant,
    tempDir: string,
    signal?: AbortSignal,
  ) => Promise<PhotoVariant>;
  downloadVideo: (
    variant: ResolvedVariant,
    tempDir: string,
    maxFileSize?: number,
    signal?: AbortSignal,
  ) => Promise<VideoVariant>;
};

type PoolTarget = {
  poolId: number;
  host: string;
  safeOnly: boolean;
};

const assetProcessor = new AssetProcessor(new AssetDownloader());

class ServerErrorStatus extends Error {
  constructor(readonly status: number) {
    super(`e621 api responded with ${status}`);
  }
}

async function fetchJson(
  url: string,
  signal?: AbortSignal,
): Promise<JsonResponse> {
  try {
    return await retryJson(url, signal);
  } catch (error) {
    if (error instanceof ServerErrorStatus) {
      return { status: error.status, data: null };
    }
    throw error;
  }
}

async function retryJson(
  url: string,
  signal?: AbortSignal,
): Promise<JsonResponse> {
  return await retryAsync(
    async () => {
      throwIfAborted(signal);
      const response = await withTimeout(
        fetch(url, {
          signal,
          headers: {
            "user-agent": API_USER_AGENT,
            accept: "application/json",
          },
        }),
        config.get("NETWORK_FETCH_INFO_TIMEOUT_MS"),
        "e621 api request",
        signal,
      );
      if (response.status >= 500) {
        throw new ServerErrorStatus(response.status);
      }

      const data = response.ok ? await response.json().catch(() => null) : null;
      return { status: response.status, data };
    },
    {
      retries: config.get("NETWORK_FETCH_INFO_RETRIES"),
      delayMs: config.get("NETWORK_RETRY_DELAY_MS"),
      shouldRetry: (error) =>
        error instanceof ServerErrorStatus || isRetryableNetworkError(error),
      signal,
    },
  );
}

function parsePoolUrl(url: string): PoolTarget | null {
  try {
    const parsed = new URL(url);
    const host = HOSTNAME.exec(parsed.hostname.toLowerCase());
    const pool = POOL_PATH.exec(parsed.pathname);
    if (!host || !pool) {
      return null;
    }

    return {
      poolId: Number(pool[1]),
      host: `${host[1]}.net`,
      safeOnly: host[1] === "e926",
    };
  } catch {
    return null;
  }
}

function normalizeRating(rating: string): ContentRating | undefined {
  return rating === "s" || rating === "q" || rating === "e"
    ? rating
    : undefined;
}

// anonymous api responses null out file urls for some posts; the path is
// derived from the md5 so it can be rebuilt
function getOriginalFileUrl(post: E621Post): string | null {
  if (post.file.url) {
    return post.file.url;
  }

  const { md5, ext } = post.file;
  if (!md5 || !ext) {
    return null;
  }

  return `${STATIC_BASE}/${md5.slice(0, 2)}/${md5.slice(2, 4)}/${md5}.${ext}`;
}

function getVideoCandidates(
  post: E621Post,
  maxFileSize?: number,
): ResolvedVariant[] {
  const alternates = post.sample?.alternates;
  const original: E621VideoSource = {
    url: getOriginalFileUrl(post),
    size: post.file.size,
    width: post.file.width,
    height: post.file.height,
  };
  // h264 mp4s first so ffmpeg only has to remux; webm originals are a last resort
  const sources = [
    post.file.ext === "mp4" ? original : undefined,
    alternates?.variants?.mp4,
    ...VIDEO_SAMPLE_KEYS.map((key) => alternates?.samples?.[key]),
    post.file.ext !== "mp4" ? original : undefined,
  ];

  const seen = new Set<string>();
  const candidates: ResolvedVariant[] = [];
  for (const source of sources) {
    if (!source?.url || seen.has(source.url)) {
      continue;
    }
    seen.add(source.url);

    if (maxFileSize !== undefined && (source.size ?? 0) > maxFileSize) {
      continue;
    }

    candidates.push({
      url: source.url,
      provider: "e621",
      width: source.width,
      height: source.height,
      estimatedSizeBytes: source.size,
    });
  }

  return candidates;
}

function cleanupEntries(entries: Array<GalleryEntry | undefined>) {
  for (const entry of entries) {
    for (const variant of entry?.variants ?? []) {
      try {
        variant.cleanup?.();
      } catch {}
    }
  }
}

export class E621PlatformHandler implements PlatformHandler {
  readonly platform = "e621" as const;

  constructor(
    private readonly deps: E621HandlerDeps = {
      fetchJson,
      downloadImage: (variant, tempDir, signal) =>
        assetProcessor.downloadImageVariant(
          variant,
          tempDir,
          undefined,
          signal,
          { maxSide: MAX_IMAGE_SIDE, background: "#ffffff" },
        ),
      downloadVideo: (variant, tempDir, maxFileSize, signal) =>
        assetProcessor.downloadVideoVariant(
          variant,
          tempDir,
          maxFileSize,
          undefined,
          signal,
        ),
    },
  ) {}

  canHandle(url: string): boolean {
    return parsePoolUrl(url) !== null;
  }

  private async fetchPool(
    poolId: number,
    signal?: AbortSignal,
  ): Promise<E621Pool> {
    const { status, data } = await this.deps.fetchJson(
      `${API_BASE}/pools/${poolId}.json`,
      signal,
    );
    if (status === 404) {
      throw new DownloadError("pool not found");
    }
    const pool = data as Partial<E621Pool> | null;
    if (status !== 200 || !pool || !Array.isArray(pool.post_ids)) {
      logger.error(`e621 pool ${poolId} request failed with status ${status}`);
      throw new DownloadError("failed to get pool info");
    }

    return pool as E621Pool;
  }

  private async fetchPostBatch(
    ids: number[],
    signal?: AbortSignal,
  ): Promise<Map<number, E621Post>> {
    const tags = encodeURIComponent(`id:${ids.join(",")}`);
    const { status, data } = await this.deps.fetchJson(
      `${API_BASE}/posts.json?tags=${tags}&limit=${ids.length}`,
      signal,
    );
    const posts = (data as { posts?: E621Post[] } | null)?.posts;
    if (status !== 200 || !Array.isArray(posts)) {
      logger.error(`e621 posts request failed with status ${status}`);
      throw new DownloadError("failed to get pool posts");
    }

    return new Map(posts.map((post) => [post.id, post]));
  }

  // walks post_ids in pool order, so the result keeps the pool's page order
  private async collectPosts(
    pool: E621Pool,
    safeOnly: boolean,
    signal?: AbortSignal,
  ): Promise<E621Post[]> {
    const collected: E621Post[] = [];
    for (
      let offset = 0;
      offset < pool.post_ids.length && collected.length < MAX_POOL_ITEMS;
      offset += POST_ID_BATCH_SIZE
    ) {
      throwIfAborted(signal);
      const ids = pool.post_ids.slice(offset, offset + POST_ID_BATCH_SIZE);
      const posts = await this.fetchPostBatch(ids, signal);
      for (const id of ids) {
        const post = posts.get(id);
        if (!post || post.flags?.deleted) {
          continue;
        }
        if (safeOnly && post.rating !== "s") {
          continue;
        }
        collected.push(post);
      }
    }

    if (
      collected.length >= MAX_POOL_ITEMS &&
      pool.post_ids.length > MAX_POOL_ITEMS
    ) {
      logger.warn(
        `e621 pool ${pool.id} has more than ${MAX_POOL_ITEMS} posts; limiting to first ${MAX_POOL_ITEMS}`,
      );
    }

    return collected.slice(0, MAX_POOL_ITEMS);
  }

  private async downloadPost(
    post: E621Post,
    host: string,
    tempDir: string,
    maxFileSize?: number,
    signal?: AbortSignal,
  ): Promise<GalleryEntry> {
    const pageUrl = `https://${host}/posts/${post.id}`;
    const contentRating = normalizeRating(post.rating);
    const ext = post.file.ext.toLowerCase();

    if (VIDEO_EXTENSIONS.has(ext)) {
      const variants: VideoVariant[] = [];
      for (const candidate of getVideoCandidates(post, maxFileSize)) {
        throwIfAborted(signal);
        const variant = await this.deps.downloadVideo(
          candidate,
          tempDir,
          maxFileSize,
          signal,
        );
        variants.push({ ...variant, downloadUrl: pageUrl, contentRating });
        if (
          variant.downloaded &&
          (maxFileSize === undefined || variant.size <= maxFileSize)
        ) {
          break;
        }
      }

      return {
        kind: "video",
        variants: variants.length
          ? variants
          : [{ downloaded: false, downloadUrl: pageUrl, contentRating }],
      };
    }

    const fileUrl = getOriginalFileUrl(post);
    if (!IMAGE_EXTENSIONS.has(ext) || !fileUrl) {
      // flash and other formats telegram can't show - surfaced as a link
      return {
        kind: "image",
        variants: [{ downloaded: false, downloadUrl: pageUrl, contentRating }],
      };
    }

    const variant = await this.deps.downloadImage(
      {
        url: fileUrl,
        provider: "e621",
        width: post.file.width,
        height: post.file.height,
      },
      tempDir,
      signal,
    );
    return {
      kind: "image",
      variants: [{ ...variant, downloadUrl: pageUrl, contentRating }],
    };
  }

  async download(
    url: string,
    _context = {},
    options?: DownloadOptions,
  ): Promise<DownloadExecutionResult> {
    const target = parsePoolUrl(url);
    if (!target) {
      throw new DownloadError("unsupported link");
    }

    const signal = options?.signal;
    const onProgress = options?.onProgress;
    const tempDir = options?.tempDir || config.get("TEMP_DIR");
    logger.debug(`starting e621 pool download for ${url}`);

    await onProgress?.({ stage: "status", message: "resolving pool..." });
    const pool = await this.fetchPool(target.poolId, signal);
    const posts = await this.collectPosts(pool, target.safeOnly, signal);
    if (!posts.length) {
      throw new DownloadError("pool has no available posts");
    }

    const entries: Array<GalleryEntry | undefined> = [];
    let completed = 0;
    const reportBatch = () =>
      onProgress?.({
        stage: "batch",
        current: completed,
        total: posts.length,
        message: `downloading items ${completed}/${posts.length}`,
      });

    try {
      await reportBatch();
      await mapWithConcurrency(
        posts,
        DOWNLOAD_CONCURRENCY,
        async (post, index) => {
          entries[index] = await this.downloadPost(
            post,
            target.host,
            tempDir,
            options?.maxFileSize,
            signal,
          );
          completed += 1;
          await reportBatch();
        },
        { signal },
      );
    } catch (error) {
      cleanupEntries(entries);
      throw error;
    }

    await onProgress?.({ stage: "completed", message: "download complete" });

    const orderedEntries = entries.filter(
      (entry): entry is GalleryEntry => entry !== undefined,
    );
    return {
      res: {
        contentType: "gallery",
        entries: orderedEntries,
      },
      cleanup: () => cleanupEntries(orderedEntries),
    };
  }
}
