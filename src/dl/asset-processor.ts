import { randomUUIDv7 } from "bun";
import { getImageResolution, recodeImageToJpeg } from "src/utils/image";
import { logger } from "src/utils/logger";
import {
  ensureMp4Video,
  getAudioDuration,
  getVideoMetadata,
  isMp4File,
  moveFile,
} from "src/utils/video";
import { AssetDownloader } from "./asset-downloader";
import { isLikelyOversizeVideo } from "./size-guard";
import type {
  DownloadProgress,
  MusicVariant,
  PhotoVariant,
  ResolvedVariant,
  VideoVariant,
} from "./types";

export class AssetProcessor {
  constructor(private readonly downloader: AssetDownloader) {}

  async downloadVideoVariant(
    variant: ResolvedVariant,
    tempDir: string,
    maxFileSize?: number,
    onProgress?: (progress: DownloadProgress) => void | Promise<void>,
  ): Promise<VideoVariant> {
    logger.debug(`downloading video from ${variant.url}...`);
    let downloadedPath: string | null = null;
    let finalPath: string | null = null;
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

        if (
          remoteSize === 0 &&
          isLikelyOversizeVideo(variant.durationSeconds, maxFileSize)
        ) {
          logger.debug(
            `skipping video download from ${variant.url} due to duration heuristic (${variant.durationSeconds}s likely exceeds limit ${maxFileSize})`,
          );
          return {
            downloadUrl: variant.url,
            downloaded: false,
          } satisfies VideoVariant;
        }
      }

      downloadedPath = await this.downloader.downloadFile(
        variant.url,
        tempDir,
        randomUUIDv7(),
        onProgress,
      );
      finalPath = `${downloadedPath}.mp4`;
      if (await isMp4File(downloadedPath).catch(() => false)) {
        moveFile(downloadedPath, finalPath);
      } else {
        await ensureMp4Video(downloadedPath, finalPath);
      }
      const sourcePath = downloadedPath;
      const mp4Path = finalPath;
      const metadata = await getVideoMetadata(mp4Path);

      return {
        payload: {
          resolution: { width: metadata.width, height: metadata.height },
          durationSeconds: metadata.durationSeconds,
        },
        downloaded: true,
        downloadUrl: variant.url,
        path: mp4Path,
        size: Bun.file(mp4Path).size,
        cleanup: () => {
          if (sourcePath !== mp4Path) {
            Bun.file(sourcePath).delete().catch();
          }
          Bun.file(mp4Path).delete().catch();
        },
      } satisfies VideoVariant;
    } catch {
      if (downloadedPath) {
        Bun.file(downloadedPath).delete().catch();
      }
      if (finalPath) {
        Bun.file(finalPath).delete().catch();
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
    onProgress?: (progress: DownloadProgress) => void | Promise<void>,
  ): Promise<PhotoVariant> {
    logger.debug(`downloading image from ${variant.url}...`);
    let path: string | null = null;
    let recodedPath: string | null = null;
    try {
      path = await this.downloader.downloadFile(variant.url, tempDir, undefined, onProgress);
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
    onProgress?: (progress: DownloadProgress) => void | Promise<void>,
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

      path = await this.downloader.downloadFile(variant.url, tempDir, undefined, onProgress);
      const downloadedPath = path;

      const durationSeconds = await getAudioDuration(downloadedPath).catch(() => undefined);

      return {
        downloaded: true,
        downloadUrl: variant.url,
        path: downloadedPath,
        size: Bun.file(downloadedPath).size,
        payload: {
          name: variant.name || contentName || undefined,
          durationSeconds,
        },
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
