import { Downloader as fetchTiktok } from "@tobyg74/tiktok-api-dl";
import type { SSSTikResponse } from "@tobyg74/tiktok-api-dl/lib/types/downloader/ssstikDownloader";
import { logger } from "src/utils/logger";
import type { Fetcher } from "./base-fetcher";

export class V2Fetcher implements Fetcher {
  private data: SSSTikResponse | null = null;

  constructor(private tiktokUrl: string) {}

  async fetchInfo(): Promise<void> {
    logger.debug("v2 fetching info");
    const res = await fetchTiktok(this.tiktokUrl, {
      version: "v2",
    });
    if (!res.result)
      throw new Error(res.message || "unknown error when fetching tiktok");
    this.data = res;
  }

  isSuccessful(): boolean | null {
    return this.data === null ? null : !!this.data.result;
  }

  getName(): string | null {
    return null;
  }

  getType(): "video" | "image" | "music" | null {
    return this.data?.result?.type || null;
  }

  getLinks(): string[][] | null {
    if (!this.data?.result) throw new Error("data hasn't been fetched");
    const type = this.getType();

    switch (type) {
      case "video":
        return [this.data.result.video?.playAddr].filter((x) => !!x);

      case "image":
        return this.data.result.images?.map((url) => [url]) || []; // 1 version per image

      case "music":
        return [this.data.result.music?.playUrl].filter((x) => !!x);
    }

    return null;
  }
}
