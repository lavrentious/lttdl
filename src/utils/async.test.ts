import { describe, expect, test } from "bun:test";
import { mapWithConcurrency, retryAsync } from "./async";

describe("mapWithConcurrency", () => {
  test("preserves item order", async () => {
    const result = await mapWithConcurrency(
      [3, 1, 2],
      2,
      async (value) => {
        await new Promise((resolve) => setTimeout(resolve, value * 5));
        return value * 10;
      },
    );

    expect(result).toEqual([30, 10, 20]);
  });

  test("does not exceed the configured concurrency", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return null;
    });

    expect(peak).toBe(2);
  });
});

describe("retryAsync", () => {
  test("retries retryable failures and then succeeds", async () => {
    let attempts = 0;

    const result = await retryAsync(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("timed out");
        }
        return "ok";
      },
      {
        retries: 2,
        shouldRetry: (error) =>
          error instanceof Error && error.message.includes("timed out"),
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });
});
