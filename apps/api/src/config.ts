import { z } from 'zod';

const LOCAL_PG = 'postgres://%s@localhost:55432/resourcehub';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL_APP: z.string().default(LOCAL_PG.replace('%s', 'resourcehub_app:app_dev_pw')),
  DATABASE_URL_PLATFORM: z
    .string()
    .default(LOCAL_PG.replace('%s', 'resourcehub_platform:platform_dev_pw')),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  /** Tenants live at `{slug}.{ROOT_DOMAIN}`. */
  ROOT_DOMAIN: z.string().default('localhost'),
  /** Platform super-admins use this host and never a tenant subdomain. */
  PLATFORM_HOST: z.string().default('admin.localhost'),
  /** Only trust X-Forwarded-Host when running behind Front Door / Container Apps ingress. */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  TENANT_HOST_CACHE_TTL_SECONDS: z.coerce.number().int().default(300),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
