import { describe, expect, test } from "bun:test";
import type { PhotoVariant, ResolvedVariant, VideoVariant } from "../../types";
import { E621PlatformHandler, type E621Post } from "./e621-platform-handler";

function buildPost(
  id: number,
  overrides: Partial<Omit<E621Post, "file">> & {
    file?: Partial<E621Post["file"]>;
  } = {},
): E621Post {
  const { file, ...rest } = overrides;
  const md5 = `${String(id).padStart(4, "0")}abcdef`;
  return {
    id,
    rating: "s",
    ...rest,
    file: {
      width: 1000,
      height: 1400,
      ext: "jpg",
      size: 1_000_000,
      md5,
      url: `https://static1.e621.net/data/${md5}.jpg`,
      ...file,
    },
  };
}

function downloadedPhoto(variant: ResolvedVariant): PhotoVariant {
  return {
    downloaded: true,
    downloadUrl: variant.url,
    path: `/tmp/${encodeURIComponent(variant.url)}.jpg`,
    size: 1,
    payload: { resolution: { width: 1, height: 1 } },
  };
}

function createHandler({
  postIds,
  posts,
  poolStatus = 200,
  downloadImage = async (variant: ResolvedVariant) => downloadedPhoto(variant),
  downloadVideo = async (variant: ResolvedVariant): Promise<VideoVariant> => ({
    downloaded: false,
    downloadUrl: variant.url,
  }),
}: {
  postIds: number[];
  posts: E621Post[];
  poolStatus?: number;
  downloadImage?: (variant: ResolvedVariant) => Promise<PhotoVariant>;
  downloadVideo?: (variant: ResolvedVariant) => Promise<VideoVariant>;
}) {
  const requests: string[] = [];
  const handler = new E621PlatformHandler({
    fetchJson: async (url) => {
      requests.push(url);
      if (url.includes("/pools/")) {
        return {
          status: poolStatus,
          data: poolStatus === 200 ? { id: 1, post_ids: postIds } : null,
        };
      }

      const tags = decodeURIComponent(new URL(url).searchParams.get("tags")!);
      const ids = new Set(tags.replace(/^id:/, "").split(",").map(Number));
      // api answers in id-descending order, not pool order
      const matched = posts
        .filter((post) => ids.has(post.id))
        .sort((a, b) => b.id - a.id);
      return { status: 200, data: { posts: matched } };
    },
    downloadImage: (variant) => downloadImage(variant),
    downloadVideo: (variant) => downloadVideo(variant),
  });

  return { handler, requests };
}

describe("E621PlatformHandler", () => {
  test("handles pool links on both domains only", () => {
    const { handler } = createHandler({ postIds: [], posts: [] });

    expect(handler.canHandle("https://e621.net/pools/57440")).toBe(true);
    expect(handler.canHandle("https://e926.net/pools/57440?page=2")).toBe(true);
    expect(handler.canHandle("https://www.e621.net/pools/57440/")).toBe(true);
    expect(handler.canHandle("https://e621.net/posts/123")).toBe(false);
    expect(handler.canHandle("https://e621.net/pools")).toBe(false);
    expect(handler.canHandle("https://example.net/pools/1")).toBe(false);
  });

  test("keeps pool order and attaches ratings", async () => {
    const postIds = [30, 10, 20];
    const { handler } = createHandler({
      postIds,
      posts: [
        buildPost(10, { rating: "q" }),
        buildPost(20, { rating: "s" }),
        buildPost(30, { rating: "e" }),
      ],
    });

    const { res } = await handler.download!(
      "https://e621.net/pools/1",
      {},
      {
        tempDir: "/tmp",
      },
    );

    expect(res.contentType).toBe("gallery");
    if (res.contentType !== "gallery") throw new Error("expected gallery");
    expect(res.entries.map((entry) => entry.variants[0]!.downloadUrl)).toEqual(
      postIds.map((id) => `https://e621.net/posts/${id}`),
    );
    expect(
      res.entries.map((entry) => entry.variants[0]!.contentRating),
    ).toEqual(["e", "q", "s"]);
  });

  test("e926 links keep only safe posts and link back to e926", async () => {
    const { handler } = createHandler({
      postIds: [1, 2, 3],
      posts: [
        buildPost(1, { rating: "e" }),
        buildPost(2, { rating: "s" }),
        buildPost(3, { rating: "q" }),
      ],
    });

    const { res } = await handler.download!(
      "https://e926.net/pools/1",
      {},
      {
        tempDir: "/tmp",
      },
    );

    if (res.contentType !== "gallery") throw new Error("expected gallery");
    expect(res.entries.map((entry) => entry.variants[0]!.downloadUrl)).toEqual([
      "https://e926.net/posts/2",
    ]);
  });

  test("skips missing and deleted posts", async () => {
    const { handler } = createHandler({
      postIds: [1, 2, 3],
      posts: [buildPost(1), buildPost(3, { flags: { deleted: true } })],
    });

    const { res } = await handler.download!(
      "https://e621.net/pools/1",
      {},
      {
        tempDir: "/tmp",
      },
    );

    if (res.contentType !== "gallery") throw new Error("expected gallery");
    expect(res.entries).toHaveLength(1);
  });

  test("rebuilds hidden file urls from md5", async () => {
    const downloaded: string[] = [];
    const { handler } = createHandler({
      postIds: [1],
      posts: [
        buildPost(1, { file: { url: null, md5: "abcdef0123", ext: "png" } }),
      ],
      downloadImage: async (variant) => {
        downloaded.push(variant.url);
        return downloadedPhoto(variant);
      },
    });

    await handler.download!(
      "https://e621.net/pools/1",
      {},
      { tempDir: "/tmp" },
    );

    expect(downloaded).toEqual([
      "https://static1.e621.net/data/ab/cd/abcdef0123.png",
    ]);
  });

  test("prefers mp4 alternates for videos and falls through failures", async () => {
    const attempted: string[] = [];
    const { handler } = createHandler({
      postIds: [1],
      posts: [
        buildPost(1, {
          file: { ext: "webm", url: "https://static/orig.webm" },
          sample: {
            alternates: {
              variants: {
                mp4: { url: "https://static/alt.mp4", size: 60_000_000 },
              },
              samples: {
                "720p": { url: "https://static/720p.mp4", size: 1000 },
                "480p": { url: "https://static/480p.mp4", size: 500 },
              },
            },
          },
        }),
      ],
      downloadVideo: async (variant) => {
        attempted.push(variant.url);
        if (variant.url.endsWith("720p.mp4")) {
          return { downloaded: false, downloadUrl: variant.url };
        }
        return {
          downloaded: true,
          downloadUrl: variant.url,
          path: "/tmp/video.mp4",
          size: 500,
          payload: { resolution: { width: 480, height: 852 } },
        };
      },
    });

    const { res } = await handler.download!(
      "https://e621.net/pools/1",
      {},
      {
        tempDir: "/tmp",
        maxFileSize: 50_000_000,
      },
    );

    // alt.mp4 is over the size limit, 720p fails, 480p succeeds, webm untouched
    expect(attempted).toEqual([
      "https://static/720p.mp4",
      "https://static/480p.mp4",
    ]);
    if (res.contentType !== "gallery") throw new Error("expected gallery");
    expect(res.entries[0]!.kind).toBe("video");
    expect(res.entries[0]!.variants.some((v) => v.downloaded)).toBe(true);
  });

  test("turns unsupported formats into links", async () => {
    let downloads = 0;
    const { handler } = createHandler({
      postIds: [1],
      posts: [buildPost(1, { file: { ext: "swf" } })],
      downloadImage: async (variant) => {
        downloads += 1;
        return downloadedPhoto(variant);
      },
    });

    const { res } = await handler.download!(
      "https://e621.net/pools/1",
      {},
      {
        tempDir: "/tmp",
      },
    );

    expect(downloads).toBe(0);
    if (res.contentType !== "gallery") throw new Error("expected gallery");
    expect(res.entries[0]!.variants[0]!.downloaded).toBe(false);
  });

  test("batches post lookups and caps pools at 100 items", async () => {
    const postIds = Array.from({ length: 250 }, (_, index) => 1000 - index);
    const { handler, requests } = createHandler({
      postIds,
      posts: postIds.map((id) => buildPost(id)),
    });

    const { res } = await handler.download!(
      "https://e621.net/pools/1",
      {},
      {
        tempDir: "/tmp",
      },
    );

    if (res.contentType !== "gallery") throw new Error("expected gallery");
    expect(res.entries).toHaveLength(100);
    expect(res.entries[99]!.variants[0]!.downloadUrl).toBe(
      `https://e621.net/posts/${postIds[99]}`,
    );
    // pool + a single posts batch: no need to look past the cap
    expect(requests).toHaveLength(2);
  });

  test("reports missing pools", async () => {
    const { handler } = createHandler({
      postIds: [],
      posts: [],
      poolStatus: 404,
    });

    await expect(
      handler.download!("https://e621.net/pools/1", {}, { tempDir: "/tmp" }),
    ).rejects.toThrow("pool not found");
  });

  test("cleans up downloaded files when cancelled", async () => {
    const controller = new AbortController();
    const cleaned: number[] = [];
    let calls = 0;
    const { handler } = createHandler({
      postIds: [1, 2, 3, 4, 5, 6],
      posts: [1, 2, 3, 4, 5, 6].map((id) => buildPost(id)),
      downloadImage: async (variant) => {
        calls += 1;
        if (calls === 2) controller.abort();
        const index = calls;
        return {
          ...downloadedPhoto(variant),
          cleanup: () => cleaned.push(index),
        };
      },
    });

    await expect(
      handler.download!(
        "https://e621.net/pools/1",
        {},
        {
          tempDir: "/tmp",
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow();
    expect(cleaned.length).toBeGreaterThan(0);
  });
});
