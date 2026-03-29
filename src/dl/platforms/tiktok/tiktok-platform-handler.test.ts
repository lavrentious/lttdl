import { describe, expect, test } from "bun:test";
import { reconcileTiktokResults } from "./tiktok-platform-handler";
import type { TiktokProviderResult } from "./types";

describe("reconcileTiktokResults", () => {
  test("keeps the dominant content kind and merges variants by entry id", () => {
    const results: TiktokProviderResult[] = [
      {
        provider: "v1",
        kind: "image",
        title: null,
        entries: [
          {
            entryId: "image:0",
            role: "gallery",
            variants: [{ url: "https://cdn-a/1.jpg", provider: "v1" }],
          },
          {
            entryId: "image:1",
            role: "gallery",
            variants: [{ url: "https://cdn-a/2.jpg", provider: "v1" }],
          },
        ],
      },
      {
        provider: "v2",
        kind: "image",
        title: null,
        entries: [
          {
            entryId: "image:0",
            role: "gallery",
            variants: [{ url: "https://cdn-b/1.jpg", provider: "v2" }],
          },
          {
            entryId: "image:1",
            role: "gallery",
            variants: [{ url: "https://cdn-b/2.jpg", provider: "v2" }],
          },
        ],
      },
      {
        provider: "v3",
        kind: "video",
        title: null,
        entries: [
          {
            entryId: "primary",
            role: "primary",
            variants: [{ url: "https://video/1.mp4", provider: "v3" }],
          },
        ],
      },
    ];

    const resolved = reconcileTiktokResults(results);

    expect(resolved.kind).toBe("image");
    expect(resolved.entries).toHaveLength(2);
    expect(resolved.entries[0]?.variants).toHaveLength(2);
    expect(resolved.entries[1]?.variants).toHaveLength(2);
  });

  test("uses the first available title from compatible providers", () => {
    const results: TiktokProviderResult[] = [
      {
        provider: "v2",
        kind: "audio",
        title: null,
        entries: [
          {
            entryId: "primary",
            role: "primary",
            variants: [{ url: "https://cdn-a/audio.mp3", provider: "v2" }],
          },
        ],
      },
      {
        provider: "v1",
        kind: "audio",
        title: "Track Title",
        entries: [
          {
            entryId: "primary",
            role: "primary",
            variants: [{ url: "https://cdn-b/audio.mp3", provider: "v1" }],
          },
        ],
      },
    ];

    const resolved = reconcileTiktokResults(results);

    expect(resolved.kind).toBe("audio");
    expect(resolved.title).toBe("Track Title");
    expect(resolved.entries[0]?.variants).toHaveLength(2);
  });
});
