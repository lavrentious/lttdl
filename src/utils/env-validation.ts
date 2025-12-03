import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),
  BOT_TOKEN: z.string(),
  TEMP_DIR: z.string().default("./temp"),
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
