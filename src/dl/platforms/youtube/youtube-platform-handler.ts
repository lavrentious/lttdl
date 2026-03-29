import { DownloadError } from "src/errors/download-error";
import type { PlatformHandler } from "../../platform-handler";

export class YoutubePlatformHandler implements PlatformHandler {
  readonly platform = "youtube" as const;

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return hostname.includes("youtube.com") || hostname === "youtu.be";
    } catch {
      return false;
    }
  }

  async resolve(): Promise<never> {
    throw new DownloadError("youtube downloads are not implemented yet");
  }
}
