import { Downloader as fetchTiktok } from "@tobyg74/tiktok-api-dl";
import type { MusicalDownResponse } from "@tobyg74/tiktok-api-dl/lib/types/downloader/musicaldownDownloader";
import { logger } from "src/utils/logger";
import type { Fetcher } from "./base-fetcher";

export class V3Fetcher implements Fetcher {
  private data: MusicalDownResponse | null = null;

  constructor(private tiktokUrl: string) {}

  async fetchInfo(): Promise<void> {
    logger.debug("v3 fetching info");
    const res = await fetchTiktok(this.tiktokUrl, {
      version: "v3",
    });
    if (!res.result)
      throw new Error(res.message || "unknown error when fetching tiktok");
    this.data = res;
  }

  isSuccessful(): boolean | null {
    return this.data === null ? null : !!this.data.result;
  }

  getType(): "video" | "image" | "music" | null {
    return this.data?.result?.type || null;
  }

  getName(): string | null {
    return null;
  }

  getLinks(): string[][] | null {
    if (!this.data?.result) throw new Error("data hasn't been fetched");
    const type = this.getType();

    switch (type) {
      case "video":
        return [
          [this.data.result.videoHD, this.data.result.videoSD].filter(
            (x): x is string => !!x,
          ),
        ];

      case "image":
        return this.data.result.images?.map((url) => [url]) || []; // 1 version per image

      case "music":
        return [[this.data.result.music].filter((x): x is string => !!x)];
    }

    return null;
  }
}
