import { describe, expect, test } from "bun:test";
import {
  DownloadError,
  getUserFacingDownloadErrorMessage,
  isCancelledError,
  isTimeoutError,
  OperationCancelledError,
  sanitizeDownloadErrorMessage,
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

describe("sanitizeDownloadErrorMessage", () => {
  test("maps yt-dlp cookie auth errors to a settings hint", () => {
    const message =
      "ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users. " +
      "Use --cookies-from-browser or --cookies for the authentication.\n" +
      "ERROR: [youtube] def: Sign in to confirm your age. This video may be inappropriate for some users. " +
      "Use --cookies-from-browser or --cookies for the authentication.";

    expect(sanitizeDownloadErrorMessage(message)).toBe(
      "some results require authentication. enable music search cookies in /settings and try again.",
    );
  });

  test("keeps only the first yt-dlp error line for user-facing output", () => {
    const message =
      "WARNING: noisy warning\n" +
      "ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats\n" +
      "ERROR: [youtube] def: Requested format is not available.";

    expect(sanitizeDownloadErrorMessage(message)).toBe(
      "[youtube] abc: Requested format is not available. Use --list-formats for a list of available formats",
    );
  });
});

describe("getUserFacingDownloadErrorMessage", () => {
  test("sanitizes download errors for user replies", () => {
    const error = new DownloadError(
      "ERROR: [youtube] abc: Sign in to confirm your age. Use --cookies for the authentication.",
    );

    expect(getUserFacingDownloadErrorMessage(error)).toBe(
      "some results require authentication. enable music search cookies in /settings and try again.",
    );
  });
});
