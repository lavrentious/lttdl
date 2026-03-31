import { z } from "zod";

export const envSchema = z.object({
  // Core runtime identity. Usually set once and rarely changed.
  NODE_ENV: z.enum(["development", "production", "test"]),
  BOT_TOKEN: z.string(),

  // local paths. defaults are ok, tweak if you want
  TEMP_DIR: z.string().default("./temp"),
  DB_PATH: z.string().default("./data/app.db"),
  YT_DLP_COOKIES_PATH: z.string().min(1).optional(), // no cookies by default, but will throw errors for age-restricted videos

  // rate limiter. defaults are ok, modify with caution
  BOT_USER_JOB_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  BOT_USER_JOB_RATE_LIMIT_PER_DAY: z.coerce.number().int().positive().default(50),
  BOT_USER_JOB_RATE_LIMIT_MINUTE_WINDOW_MS: z.coerce.number().int().positive().default(60 * 1000),
  BOT_USER_JOB_RATE_LIMIT_DAY_WINDOW_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),

  // bot UX and job behavior. defaults are ok, change if needed
  BOT_PROGRESS_UPDATE_INTERVAL_MS: z.coerce.number().int().positive().default(1200),
  BOT_MAX_ACTIVE_JOBS_PER_USER: z.coerce.number().int().positive().default(4),
  BOT_MUSIC_PAGE_SIZE: z.coerce.number().int().positive().default(5),
  BOT_MUSIC_SEARCH_LIMIT: z.coerce.number().int().positive().default(20),
  BOT_MUSIC_SEARCH_TTL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  
  // yt-dlp behavior. defaults seem ok, you probably shouldn't touch this (unless needed)
  YT_DLP_CONCURRENT_FRAGMENTS: z.coerce.number().int().positive().default(4),
  YT_DLP_YOUTUBE_METADATA_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  YT_DLP_YOUTUBE_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(20 * 60 * 1000),
  YT_DLP_MUSIC_SEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  YT_DLP_MUSIC_METADATA_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  YT_DLP_MUSIC_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(20 * 60 * 1000),
  YT_DLP_THUMBNAIL_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  
  // generic network retry knobs. you sholdn't touch this (unless needed)
  NETWORK_FETCH_INFO_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  NETWORK_FETCH_INFO_RETRIES: z.coerce.number().int().min(0).default(1),
  NETWORK_RETRY_DELAY_MS: z.coerce.number().int().min(0).default(300),
  ASSET_FILE_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  ASSET_FILE_DOWNLOAD_RETRIES: z.coerce.number().int().min(0).default(1),
  
  // local media processing timeouts. you REALLY sholdn't touch this (unless needed)
  VIDEO_FFPROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  VIDEO_FFMPEG_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  IMAGE_PROCESS_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // don't touch. Telegram default for bots, or see https://grammy.dev/guide/files#file-size-limits idk
  BOT_MAX_FILE_SIZE_MB: z.coerce.number().int().positive().default(50),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnvOrThrow(): Env {
  try {
    return envSchema.parse(process.env);
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new Error(z.prettifyError(e));
    }
    throw e;
  }
}

class Config {
  private env: Env | null = null;

  public get<K extends keyof Env>(key: K): Env[K] {
    if (!this.env) {
      throw new Error("config is not initialized");
    }
    return this.env[key];
  }

  public init(env: Env) {
    this.env = env;
  }
}

export const config = new Config();
