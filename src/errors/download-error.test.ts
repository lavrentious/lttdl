import { describe, expect, test } from "bun:test";
import {
  DownloadError,
  isCancelledError,
  isTimeoutError,
  OperationCancelledError,
  toDownloadError,
} from "./download-error";

describe("toDownloadError", () => {
  test("preserves existing download errors", () => {
    const error = new DownloadError("unsupported link");

    expect(toDownloadError(error)).toBe(error);
  });

  test("converts timeout-like errors to timeout exceeded", () => {
    expect(toDownloadError(new Error("yt-dlp music search timed out after 30000ms"))).toEqual(
      new DownloadError("timeout exceeded"),
    );
  });

  test("maps cancellation to operation cancelled", () => {
    expect(toDownloadError(new DOMException("The operation was aborted", "AbortError"))).toEqual(
      new OperationCancelledError("operation cancelled"),
    );
    expect(toDownloadError(new OperationCancelledError("operation cancelled"))).toEqual(
      new OperationCancelledError("operation cancelled"),
    );
  });

  test("keeps unknown failures generic", () => {
    expect(toDownloadError(new Error("boom"))).toEqual(
      new DownloadError("internal error"),
    );
  });
});

describe("isTimeoutError", () => {
  test("recognizes timeout-shaped failures", () => {
    expect(isTimeoutError(new Error("request timeout"))).toBe(true);
    expect(isTimeoutError(new Error("request timed out"))).toBe(true);
  });
});

describe("isCancelledError", () => {
  test("recognizes cancellation-shaped failures", () => {
    expect(isCancelledError(new OperationCancelledError("operation cancelled"))).toBe(true);
    expect(isCancelledError(new Error("download cancelled by user"))).toBe(true);
    expect(isCancelledError(new Error("request timeout"))).toBe(false);
  });
});
