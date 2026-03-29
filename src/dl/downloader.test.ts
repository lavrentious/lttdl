import { describe, expect, test } from "bun:test";
import { DownloadError } from "src/errors/download-error";
import type { PlatformHandler } from "./platform-handler";
import { DownloadRouter } from "./downloader";

function createHandler(
  platform: PlatformHandler["platform"],
  pattern: string,
): PlatformHandler {
  return {
    platform,
    canHandle(url: string) {
      return url.includes(pattern);
    },
    async resolve() {
      throw new Error("not used in router test");
    },
  };
}

describe("DownloadRouter", () => {
  test("routes urls to the first matching handler", () => {
    const router = new DownloadRouter([
      createHandler("youtube", "youtube.com"),
      createHandler("tiktok", "tiktok.com"),
    ]);

    const handler = router.resolveHandler("https://www.tiktok.com/@user/video/1");

    expect(handler.platform).toBe("tiktok");
  });

  test("throws a DownloadError for unsupported links", () => {
    const router = new DownloadRouter([createHandler("tiktok", "tiktok.com")]);

    expect(() => router.resolveHandler("https://example.com/post/1")).toThrow(
      new DownloadError("unsupported link"),
    );
  });
});
