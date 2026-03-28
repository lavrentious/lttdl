import { describe, expect, test } from "bun:test";
import {
  buildImageLinksMessages,
  buildSingleMediaLinksMessage,
  splitLinkBlock,
} from "./download-presentation";
import type { PhotoVariant } from "src/dl/downloader";

describe("splitLinkBlock", () => {
  test("splits oversized lines safely", () => {
    const chunks = splitLinkBlock("a".repeat(9000), 4000);

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
  });
});

describe("buildSingleMediaLinksMessage", () => {
  test("formats selected and attempted links", () => {
    expect(
      buildSingleMediaLinksMessage(["https://a", "https://b"]),
    ).toContain("other attempted links");
  });
});

describe("buildImageLinksMessages", () => {
  test("numbers images from 1", () => {
    const variant: PhotoVariant = {
      downloaded: false,
      downloadUrl: "https://example.com/image.jpg",
    };

    const messages = buildImageLinksMessages([[variant]]);

    expect(messages[0]).toStartWith("image 1:");
  });
});
