import { describe, expect, test } from "bun:test";
import { shouldFallbackToMusicSearch } from "./music";

describe("shouldFallbackToMusicSearch", () => {
  test("accepts plain text queries", () => {
    expect(shouldFallbackToMusicSearch("bruno mars")).toBe(true);
    expect(shouldFallbackToMusicSearch("  daft punk  ")).toBe(true);
  });

  test("rejects empty text and slash commands", () => {
    expect(shouldFallbackToMusicSearch("")).toBe(false);
    expect(shouldFallbackToMusicSearch("   ")).toBe(false);
    expect(shouldFallbackToMusicSearch("/music bruno mars")).toBe(false);
    expect(shouldFallbackToMusicSearch("/settings")).toBe(false);
  });
});
