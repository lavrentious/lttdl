import { getImageResolution, recodeImageToJpeg } from "src/utils/image";
import { logger } from "src/utils/logger";
import { getVideoResolution } from "src/utils/video";
import { AssetDownloader } from "./asset-downloader";
import type { MusicVariant, PhotoVariant, ResolvedVariant, VideoVariant } from "./types";

export class AssetProcessor {
  constructor(private readonly downloader: AssetDownloader) {}

  async downloadVideoVariant(
    variant: ResolvedVariant,
    tempDir: string,
    maxFileSize?: number,
  ): Promise<VideoVariant> {
    logger.debug(`downloading video from ${variant.url}...`);
    let path: string | null = null;
    try {
      if (maxFileSize !== undefined) {
        const remoteSize = await this.downloader
          .getRemoteContentLength(variant.url)
          .catch(() => 0);
        if (remoteSize > maxFileSize) {
          logger.debug(
            `skipping video download from ${variant.url} (size ${remoteSize} exceeds limit ${maxFileSize})`,
          );
          return {
            downloadUrl: variant.url,
            downloaded: false,
          } satisfies VideoVariant;
        }
      }

      path = await this.downloader.downloadFile(variant.url, tempDir);
      const downloadedPath = path;
      const resolution = await getVideoResolution(downloadedPath);

      return {
        payload: { resolution },
        downloaded: true,
        downloadUrl: variant.url,
        path: downloadedPath,
        size: Bun.file(downloadedPath).size,
        cleanup: () => {
          Bun.file(downloadedPath).delete().catch();
        },
      } satisfies VideoVariant;
    } catch {
      if (path) {
        Bun.file(path).delete().catch();
      }
      logger.warn(`failed to download video from ${variant.url}`);
      return {
        downloadUrl: variant.url,
        downloaded: false,
      } satisfies VideoVariant;
    }
  }

  async downloadImageVariant(
    variant: ResolvedVariant,
    tempDir: string,
  ): Promise<PhotoVariant> {
    logger.debug(`downloading image from ${variant.url}...`);
    let path: string | null = null;
    let recodedPath: string | null = null;
    try {
      path = await this.downloader.downloadFile(variant.url, tempDir);
      recodedPath = `${path}.jpg`;
      const downloadedPath = path;
      const finalPath = recodedPath;

      await recodeImageToJpeg(downloadedPath, finalPath);
      const resolution = await getImageResolution(finalPath);

      return {
        payload: { resolution },
        downloaded: true,
        downloadUrl: variant.url,
        path: finalPath,
        size: Bun.file(finalPath).size,
        cleanup: () => {
          Bun.file(downloadedPath).delete().catch();
          Bun.file(finalPath).delete().catch();
        },
      } satisfies PhotoVariant;
    } catch {
      if (path) {
        Bun.file(path).delete().catch();
      }
      if (recodedPath) {
        Bun.file(recodedPath).delete().catch();
      }
      logger.warn(`failed to download image from ${variant.url}`);
      return {
        downloaded: false,
        downloadUrl: variant.url,
      } satisfies PhotoVariant;
    }
  }

  async downloadAudioVariant(
    variant: ResolvedVariant,
    tempDir: string,
    contentName: string | null,
    maxFileSize?: number,
  ): Promise<MusicVariant> {
    logger.debug(`downloading audio from ${variant.url}...`);
    let path: string | null = null;
    try {
      if (maxFileSize !== undefined) {
        const remoteSize = await this.downloader
          .getRemoteContentLength(variant.url)
          .catch(() => 0);
        if (remoteSize > maxFileSize) {
          logger.debug(
            `skipping audio download from ${variant.url} (size ${remoteSize} exceeds limit ${maxFileSize})`,
          );
          return {
            downloaded: false,
            downloadUrl: variant.url,
          } satisfies MusicVariant;
        }
      }

      path = await this.downloader.downloadFile(variant.url, tempDir);
      const downloadedPath = path;

      return {
        downloaded: true,
        downloadUrl: variant.url,
        path: downloadedPath,
        size: Bun.file(downloadedPath).size,
        payload: { name: variant.name || contentName || undefined },
        cleanup: () => {
          Bun.file(downloadedPath).delete().catch();
        },
      } satisfies MusicVariant;
    } catch {
      if (path) {
        Bun.file(path).delete().catch();
      }
      logger.warn(`failed to download audio from ${variant.url}`);
      return {
        downloaded: false,
        downloadUrl: variant.url,
      } satisfies MusicVariant;
    }
  }
}
