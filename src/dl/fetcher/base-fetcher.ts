export interface Fetcher {
  fetchInfo(): Promise<void>;

  isSuccessful(): boolean | null;

  getType(): "video" | "image" | "music" | null;

  getName(): string | null;

  getLinks(): string[][] | null; // multiple variants PER 1 ENTRY
  // if it's a video, then [[url1, url2, url3, ...]]
  // if it's a photo, then [[photo1_url1, photo1_url2, photo1_url3, ...], [photo2_url1, photo2_url2, photo2_url3], ...]
}
