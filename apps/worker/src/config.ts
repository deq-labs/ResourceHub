import { z } from 'zod';

const LOCAL_PG = 'postgres://%s@localhost:55432/resourcehub';

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL_APP: z.string().default(LOCAL_PG.replace('%s', 'resourcehub_app:app_dev_pw')),
  DATABASE_URL_PLATFORM: z
    .string()
    .default(LOCAL_PG.replace('%s', 'resourcehub_platform:platform_dev_pw')),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  SMTP_URL: z.string().default('smtp://localhost:1025'),
  MAIL_FROM: z.string().default('ResourceHub <no-reply@resourcehub.local>'),
  KEY_VAULT_URL: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().default(5),
  BREAKER_OPEN_SECONDS: z.coerce.number().int().default(120),
});

export type WorkerConfig = z.infer<typeof Schema>;

export function loadWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
  const parsed = Schema.safeParse(env);
  if (!parsed.success)
    throw new Error(`Invalid worker configuration:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function redisConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    // BullMQ workers block on Redis; they must not give up on a slow command.
    maxRetriesPerRequest: null,
  };
}
