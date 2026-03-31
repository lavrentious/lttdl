import { describe, expect, test } from "bun:test";
import { OperationCancelledError } from "src/errors/download-error";
import { PinterestPlatformHandler } from "./pinterest-platform-handler";

function buildImageItem(id: number) {
  return {
    id,
    src: `https://i.pinimg.com/originals/${id}.jpg`,
    origin: `https://www.pinterest.com/pin/${id}/`,
    resolution: {
      x: 800,
      y: 1200,
    },
  };
}

function buildVideoItem(id: number) {
  return {
    id,
    src: `https://i.pinimg.com/originals/${id}.jpg`,
    origin: `https://www.pinterest.com/pin/${id}/`,
    resolution: {
      x: 800,
      y: 1200,
    },
    media_stream: {
      video: {
        url: `https://v1.pinimg.com/videos/${id}.m3u8`,
        resolution: [1280, 720] as [number, number],
        duration: 10,
      },
    },
  };
}

describe("PinterestPlatformHandler", () => {
  test("returns image result for all-image boards", async () => {
    const progressStages: string[] = [];
    const handler = new PinterestPlatformHandler({
      which: () => "/usr/bin/pinterest-dl",
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          command: "scrape",
          results: [
            {
              input: "https://pin.it/example",
              items: [buildImageItem(1), buildImageItem(2)],
            },
          ],
        }),
        stderr: "",
      }),
      downloadImageItem: async (item, _tempDir, onProgress) => {
        await onProgress?.({
          stage: "download",
          percent: 50,
        });
        return {
          downloaded: true,
          downloadUrl: item.origin,
          path: `/tmp/${item.id}.jpg`,
          size: 1,
          payload: {
            resolution: {
              width: 800,
              height: 1200,
            },
          },
        };
      },
      downloadVideoItem: async () => ({
        downloaded: false,
        downloadUrl: "https://example.com",
      }),
    });

    const result = await handler.download!("https://pin.it/example", {}, {
      tempDir: "/tmp",
      onProgress: (progress) => {
        progressStages.push(progress.stage);
      },
    });

    expect(result.res.contentType).toBe("image");
    if (result.res.contentType !== "image") {
      throw new Error("expected image result");
    }
    expect(result.res.variants).toHaveLength(2);
    expect(progressStages).toContain("status");
    expect(progressStages).toContain("download");
    expect(progressStages).toContain("completed");
  });

  test("returns gallery result for mixed boards and limits item count to 100", async () => {
    let imageDownloads = 0;
    let videoDownloads = 0;
    const items = Array.from({ length: 101 }, (_, index) =>
      index % 2 === 0 ? buildImageItem(index + 1) : buildVideoItem(index + 1),
    );
    const handler = new PinterestPlatformHandler({
      which: () => "/usr/bin/pinterest-dl",
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          command: "scrape",
          results: [
            {
              input: "https://www.pinterest.com/board/example",
              items,
            },
          ],
        }),
        stderr: "",
      }),
      downloadImageItem: async (item) => {
        imageDownloads += 1;
        return {
          downloaded: true,
          downloadUrl: item.origin,
          path: `/tmp/${item.id}.jpg`,
          size: 1,
          payload: {
            resolution: {
              width: 800,
              height: 1200,
            },
          },
        };
      },
      downloadVideoItem: async (item) => {
        videoDownloads += 1;
        return {
          downloaded: true,
          downloadUrl: item.origin,
          path: `/tmp/${item.id}.mp4`,
          size: 1,
          payload: {
            resolution: {
              width: 1280,
              height: 720,
            },
          },
        };
      },
    });

    const result = await handler.download!(
      "https://www.pinterest.com/board/example",
      {},
      { tempDir: "/tmp" },
    );

    expect(result.res.contentType).toBe("gallery");
    if (result.res.contentType !== "gallery") {
      throw new Error("expected gallery result");
    }
    expect(result.res.entries).toHaveLength(100);
    expect(imageDownloads + videoDownloads).toBe(100);
  });

  test("fails clearly when pinterest-dl is missing", async () => {
    const handler = new PinterestPlatformHandler({
      which: () => null,
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      downloadImageItem: async () => ({
        downloaded: false,
        downloadUrl: "https://example.com",
      }),
      downloadVideoItem: async () => ({
        downloaded: false,
        downloadUrl: "https://example.com",
      }),
    });

    await expect(
      handler.download!("https://pin.it/example", {}, {}),
    ).rejects.toThrow("pinterest-dl is not installed");
  });

  test("cleans up already-downloaded items when cancelled mid-board", async () => {
    const cleaned: string[] = [];
    let downloadCount = 0;
    const handler = new PinterestPlatformHandler({
      which: () => "/usr/bin/pinterest-dl",
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          command: "scrape",
          results: [
            {
              input: "https://www.pinterest.com/board/example",
              items: [buildImageItem(1), buildImageItem(2), buildImageItem(3)],
            },
          ],
        }),
        stderr: "",
      }),
      downloadImageItem: async (item, _tempDir, _onProgress, signal) => {
        downloadCount += 1;
        if (downloadCount === 1) {
          controller.abort(new OperationCancelledError("operation cancelled"));
        }
        if (downloadCount === 2) {
          throw signal?.reason instanceof Error
            ? signal.reason
            : new OperationCancelledError("operation cancelled");
        }

        return {
          downloaded: true,
          downloadUrl: item.origin,
          path: `/tmp/${item.id}.jpg`,
          size: 1,
          payload: {
            resolution: {
              width: 800,
              height: 1200,
            },
          },
          cleanup: () => {
            cleaned.push(String(item.id));
          },
        };
      },
      downloadVideoItem: async () => ({
        downloaded: false,
        downloadUrl: "https://example.com",
      }),
    });
    const controller = new AbortController();

    await expect(
      handler.download!(
        "https://www.pinterest.com/board/example",
        {},
        {
          tempDir: "/tmp",
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow("operation cancelled");
    expect(cleaned).toEqual(["1"]);
  });
});
