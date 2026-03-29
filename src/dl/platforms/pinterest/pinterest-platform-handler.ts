import { DownloadError } from "src/errors/download-error";
import type { PlatformHandler } from "../../platform-handler";

export class PinterestPlatformHandler implements PlatformHandler {
  readonly platform = "pinterest" as const;

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return ["pinterest.com", "pin.it"].some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
      );
    } catch {
      return false;
    }
  }

  async resolve(): Promise<never> {
    throw new DownloadError("pinterest downloads are not implemented yet");
  }
}
