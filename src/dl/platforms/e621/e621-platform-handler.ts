import { buildOversizeMessage } from "src/dl/size-guard";
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
  DownloadProgress,
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
// /post/show/N is the legacy post url, still linked from older sites
const POST_PATH = /^\/(?:posts|post\/show)\/(\d+)(?:\.json)?\/?$/;
const MAX_POOL_ITEMS = 100;
const POST_ID_BATCH_SIZE = 100;
const DOWNLOAD_CONCURRENCY = 4;
// telegram rejects photos with width + height > 10000; it shrinks past 2560 anyway
const MAX_IMAGE_SIDE = 4096;
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm"]);

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

type ProgressCallback = (progress: DownloadProgress) => void | Promise<void>;

type E621HandlerDeps = {
  fetchJson: (url: string, signal?: AbortSignal) => Promise<JsonResponse>;
  downloadImage: (
    variant: ResolvedVariant,
    tempDir: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ) => Promise<PhotoVariant>;
  downloadVideo: (
    variant: ResolvedVariant,
    tempDir: string,
    maxFileSize?: number,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ) => Promise<VideoVariant>;
};

type Target = {
  kind: "pool" | "post";
  id: number;
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

function parseTarget(url: string): Target | null {
  try {
    const parsed = new URL(url);
    const host = HOSTNAME.exec(parsed.hostname.toLowerCase());
    if (!host) {
      return null;
    }

    const pool = POOL_PATH.exec(parsed.pathname);
    const post = pool ? null : POST_PATH.exec(parsed.pathname);
    const id = pool?.[1] ?? post?.[1];
    if (!id) {
      return null;
    }

    return {
      kind: pool ? "pool" : "post",
      id: Number(id),
      host: `${host[1]}.net`,
      safeOnly: host[1] === "e926",
    };
  } catch {
    return null;
  }
}

function isVideoPost(post: E621Post): boolean {
  return VIDEO_EXTENSIONS.has(post.file.ext.toLowerCase());
}

function isMp4Url(url: string): boolean {
  return url.split("?")[0]!.toLowerCase().endsWith(".mp4");
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

// every encode e621 lists, best first: mp4s by resolution, then webms by
// resolution. webm originals (vp9/av1) need ffmpeg and may not play inline
// in telegram, so they're only used when no mp4 fits
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
  const area = (source: E621VideoSource) =>
    (source.width ?? 0) * (source.height ?? 0);
  // sort is stable, so the original wins ties against same-size encodes
  const sources = [
    original,
    ...Object.values(alternates?.variants ?? {}),
    ...Object.values(alternates?.samples ?? {}),
  ]
    .filter((source): source is E621VideoSource & { url: string } =>
      Boolean(source?.url),
    )
    .sort(
      (a, b) =>
        Number(isMp4Url(b.url)) - Number(isMp4Url(a.url)) || area(b) - area(a),
    );

  const seen = new Set<string>();
  const candidates: ResolvedVariant[] = [];
  for (const source of sources) {
    if (seen.has(source.url)) {
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
      downloadImage: (variant, tempDir, onProgress, signal) =>
        assetProcessor.downloadImageVariant(
          variant,
          tempDir,
          onProgress,
          signal,
          { maxSide: MAX_IMAGE_SIDE, background: "#ffffff" },
        ),
      downloadVideo: (variant, tempDir, maxFileSize, onProgress, signal) =>
        assetProcessor.downloadVideoVariant(
          variant,
          tempDir,
          maxFileSize,
          onProgress,
          signal,
        ),
    },
  ) {}

  canHandle(url: string): boolean {
    return parseTarget(url) !== null;
  }

  private async fetchPost(
    target: Target,
    signal?: AbortSignal,
  ): Promise<E621Post> {
    const { status, data } = await this.deps.fetchJson(
      `${API_BASE}/posts/${target.id}.json`,
      signal,
    );
    const post = (data as { post?: E621Post } | null)?.post;
    // e926 only serves safe posts, anything else doesn't exist there
    if (status === 404 || (post && target.safeOnly && post.rating !== "s")) {
      throw new DownloadError("post not found");
    }
    if (status !== 200 || !post?.file) {
      logger.error(
        `e621 post ${target.id} request failed with status ${status}`,
      );
      throw new DownloadError("failed to get post info");
    }
    if (post.flags?.deleted) {
      throw new DownloadError("post was deleted");
    }

    return post;
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
    onProgress?: ProgressCallback,
  ): Promise<GalleryEntry> {
    const pageUrl = `https://${host}/posts/${post.id}`;
    const contentRating = normalizeRating(post.rating);
    const ext = post.file.ext.toLowerCase();

    if (isVideoPost(post)) {
      const variants: VideoVariant[] = [];
      try {
        for (const candidate of getVideoCandidates(post, maxFileSize)) {
          throwIfAborted(signal);
          const variant = await this.deps.downloadVideo(
            candidate,
            tempDir,
            maxFileSize,
            onProgress,
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
      } catch (error) {
        cleanupEntries([{ kind: "video", variants }]);
        throw error;
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
      onProgress,
      signal,
    );
    return {
      kind: "image",
      variants: [{ ...variant, downloadUrl: pageUrl, contentRating }],
    };
  }

  private async downloadSinglePost(
    target: Target,
    tempDir: string,
    options?: DownloadOptions,
  ): Promise<DownloadExecutionResult> {
    const maxFileSize = options?.maxFileSize;
    await options?.onProgress?.({
      stage: "status",
      message: "resolving post...",
    });
    const post = await this.fetchPost(target, options?.signal);
    const ext = post.file.ext.toLowerCase();
    if (!isVideoPost(post) && !IMAGE_EXTENSIONS.has(ext)) {
      throw new DownloadError(`unsupported file format: ${ext}`);
    }

    if (
      isVideoPost(post) &&
      maxFileSize !== undefined &&
      !getVideoCandidates(post, maxFileSize).length
    ) {
      const sizes = getVideoCandidates(post).map(
        (candidate) => candidate.estimatedSizeBytes ?? Infinity,
      );
      throw new DownloadError(
        buildOversizeMessage({
          estimatedSizeBytes: sizes.length ? Math.min(...sizes) : undefined,
          exact: true,
        }),
      );
    }

    const entry = await this.downloadPost(
      post,
      target.host,
      tempDir,
      maxFileSize,
      options?.signal,
      options?.onProgress,
    );
    const cleanup = () => cleanupEntries([entry]);
    if (!entry.variants.some((variant) => variant.downloaded)) {
      cleanup();
      throw new DownloadError(`failed to download ${entry.kind}`);
    }

    await options?.onProgress?.({
      stage: "completed",
      message: "download complete",
    });

    // single posts take the regular single-media path: compressed photo, or
    // the best-fitting video sent with its own dimensions and duration
    return {
      res:
        entry.kind === "image"
          ? { contentType: "image", variants: [entry.variants] }
          : { contentType: "video", variants: entry.variants },
      cleanup,
    };
  }

  async download(
    url: string,
    _context = {},
    options?: DownloadOptions,
  ): Promise<DownloadExecutionResult> {
    const target = parseTarget(url);
    if (!target) {
      throw new DownloadError("unsupported link");
    }

    const signal = options?.signal;
    const onProgress = options?.onProgress;
    const tempDir = options?.tempDir || config.get("TEMP_DIR");
    logger.debug(`starting e621 ${target.kind} download for ${url}`);

    if (target.kind === "post") {
      return await this.downloadSinglePost(target, tempDir, options);
    }

    await onProgress?.({ stage: "status", message: "resolving pool..." });
    const pool = await this.fetchPool(target.id, signal);
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
