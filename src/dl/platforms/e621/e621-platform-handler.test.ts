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

      const single = /\/posts\/(\d+)\.json$/.exec(url);
      if (single) {
        const post = posts.find(
          (candidate) => candidate.id === Number(single[1]),
        );
        return post
          ? { status: 200, data: { post } }
          : { status: 404, data: null };
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
  test("handles pool and post links on both domains only", () => {
    const { handler } = createHandler({ postIds: [], posts: [] });

    expect(handler.canHandle("https://e621.net/pools/57440")).toBe(true);
    expect(handler.canHandle("https://e926.net/pools/57440?page=2")).toBe(true);
    expect(handler.canHandle("https://www.e621.net/pools/57440/")).toBe(true);
    expect(handler.canHandle("https://e621.net/posts/123")).toBe(true);
    expect(handler.canHandle("https://e926.net/posts/123?q=pool:1")).toBe(true);
    expect(handler.canHandle("https://e621.net/post/show/123")).toBe(true);
    expect(handler.canHandle("https://e621.net/posts")).toBe(false);
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

  test("tries video encodes best-fitting first, webm last", async () => {
    const attempted: string[] = [];
    const { handler } = createHandler({
      postIds: [1],
      posts: [
        buildPost(1, {
          file: {
            ext: "webm",
            url: "https://static/orig.webm",
            width: 2160,
            height: 3840,
            size: 30_000_000,
          },
          sample: {
            alternates: {
              variants: {
                mp4: {
                  url: "https://static/alt.mp4",
                  width: 1080,
                  height: 1920,
                  size: 60_000_000,
                },
              },
              samples: {
                "480p": {
                  url: "https://static/480p.mp4",
                  width: 480,
                  height: 852,
                  size: 500,
                },
                "720p": {
                  url: "https://static/720p.mp4",
                  width: 720,
                  height: 1280,
                  size: 1000,
                },
              },
            },
          },
        }),
      ],
      downloadVideo: async (variant) => {
        attempted.push(variant.url);
        // every mp4 fails, so the webm fallback is reached
        return variant.url.endsWith(".webm")
          ? {
              downloaded: true,
              downloadUrl: variant.url,
              path: "/tmp/video.mp4",
              size: 500,
              payload: { resolution: { width: 2160, height: 3840 } },
            }
          : { downloaded: false, downloadUrl: variant.url };
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

    // alt.mp4 is over the size limit; mp4s by resolution before the webm
    expect(attempted).toEqual([
      "https://static/720p.mp4",
      "https://static/480p.mp4",
      "https://static/orig.webm",
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

  test("sends a single image post as a regular image with its rating", async () => {
    const downloaded: string[] = [];
    const { handler } = createHandler({
      postIds: [],
      posts: [buildPost(7, { rating: "e" })],
      downloadImage: async (variant) => {
        downloaded.push(variant.url);
        return downloadedPhoto(variant);
      },
    });

    const { res } = await handler.download!(
      "https://e621.net/posts/7",
      {},
      {
        tempDir: "/tmp",
      },
    );

    expect(downloaded).toEqual([buildPost(7).file.url!]);
    if (res.contentType !== "image") throw new Error("expected image");
    expect(res.variants).toHaveLength(1);
    expect(res.variants[0]![0]!.contentRating).toBe("e");
    expect(res.variants[0]![0]!.downloadUrl).toBe("https://e621.net/posts/7");
  });

  test("sends a single video post as the best encode that fits", async () => {
    const attempted: string[] = [];
    const { handler } = createHandler({
      postIds: [],
      posts: [
        buildPost(8, {
          rating: "q",
          file: {
            ext: "mp4",
            url: "https://static/orig.mp4",
            width: 1920,
            height: 1080,
            size: 80_000_000,
          },
          sample: {
            alternates: {
              samples: {
                "480p": {
                  url: "https://static/480p.mp4",
                  width: 854,
                  height: 480,
                  size: 8_000_000,
                },
                "720p": {
                  url: "https://static/720p.mp4",
                  width: 1280,
                  height: 720,
                  size: 20_000_000,
                },
              },
            },
          },
        }),
      ],
      downloadVideo: async (variant) => {
        attempted.push(variant.url);
        return {
          downloaded: true,
          downloadUrl: variant.url,
          path: "/tmp/video.mp4",
          size: variant.estimatedSizeBytes!,
          payload: { resolution: { width: 1280, height: 720 } },
        };
      },
    });

    const { res } = await handler.download!(
      "https://e621.net/posts/8",
      {},
      {
        tempDir: "/tmp",
        maxFileSize: 50_000_000,
      },
    );

    expect(attempted).toEqual(["https://static/720p.mp4"]);
    if (res.contentType !== "video") throw new Error("expected video");
    expect(res.variants[0]!.contentRating).toBe("q");
  });

  test("reports single videos that are too large in every encode", async () => {
    const { handler } = createHandler({
      postIds: [],
      posts: [
        buildPost(9, {
          file: {
            ext: "mp4",
            url: "https://static/orig.mp4",
            size: 90_000_000,
          },
          sample: {
            alternates: {
              samples: {
                "480p": { url: "https://static/480p.mp4", size: 60_000_000 },
              },
            },
          },
        }),
      ],
    });

    await expect(
      handler.download!(
        "https://e621.net/posts/9",
        {},
        {
          tempDir: "/tmp",
          maxFileSize: 50_000_000,
        },
      ),
    ).rejects.toThrow("video is too large to upload (57.2 MB)");
  });

  test("hides non-safe posts on e926", async () => {
    const { handler } = createHandler({
      postIds: [],
      posts: [buildPost(10, { rating: "e" })],
    });

    await expect(
      handler.download!("https://e926.net/posts/10", {}, { tempDir: "/tmp" }),
    ).rejects.toThrow("post not found");
  });

  test("rejects missing, deleted and unsupported single posts", async () => {
    const { handler } = createHandler({
      postIds: [],
      posts: [
        buildPost(11, { flags: { deleted: true } }),
        buildPost(12, { file: { ext: "swf" } }),
      ],
    });
    const download = (id: number) =>
      handler.download!(
        `https://e621.net/posts/${id}`,
        {},
        { tempDir: "/tmp" },
      );

    await expect(download(404)).rejects.toThrow("post not found");
    await expect(download(11)).rejects.toThrow("post was deleted");
    await expect(download(12)).rejects.toThrow("unsupported file format: swf");
  });

  test("fails single posts whose download failed", async () => {
    const { handler } = createHandler({
      postIds: [],
      posts: [buildPost(13)],
      downloadImage: async (variant) => ({
        downloaded: false,
        downloadUrl: variant.url,
      }),
    });

    await expect(
      handler.download!("https://e621.net/posts/13", {}, { tempDir: "/tmp" }),
    ).rejects.toThrow("failed to download image");
  });
});
