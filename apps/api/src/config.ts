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
  /** When set, requests must carry this X-Azure-FDID header (i.e. came through our Front Door). */
  FRONT_DOOR_ID: z.string().optional(),
  TENANT_HOST_CACHE_TTL_SECONDS: z.coerce.number().int().default(300),

  // ---- Auth -------------------------------------------------------------------------------
  /** `dev`: built-in mock OIDC provider ("sign in as"). `entra`: Microsoft Entra External ID. */
  AUTH_PROVIDER: z.enum(['dev', 'entra']).default('dev'),
  /** OIDC issuer. For Entra External ID: https://{tenant}.ciamlogin.com/{tenantId}/v2.0 */
  OIDC_ISSUER: z.string().default('http://localhost:3000/api/v1/dev-idp'),
  OIDC_CLIENT_ID: z.string().default('resourcehub-local'),
  /** Optional: confidential client secret (Key Vault in Azure). PKCE is always used. */
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_SCOPES: z.string().default('openid profile email'),
  /** HS256 key for API-issued access tokens and the short-lived OIDC state cookie. */
  AUTH_JWT_SECRET: z.string().min(32).default('local-dev-only-secret-change-me-0123456789'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(14),
  /** Secure cookies need https; locally the SPA is served over http on *.localhost. */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Scheme used to build absolute callback URLs (https behind Front Door). */
  PUBLIC_SCHEME: z.enum(['http', 'https']).default('http'),

  // ---- Blob storage ---------------------------------------------------------------------
  /** Azurite's well-known public dev key. In Azure, set STORAGE_ACCOUNT_URL instead (managed identity). */
  STORAGE_CONNECTION_STRING: z
    .string()
    .default(
      'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;',
    ),
  STORAGE_ACCOUNT_URL: z.string().optional(),
  STORAGE_CONTAINER: z.string().default('tenant-files'),

  // ---- Custom domains -------------------------------------------------------------------
  /** `dns`: real TXT lookup. `dev`: *.localhost / *.test hostnames verify instantly for demos. */
  DOMAIN_VERIFICATION_MODE: z.enum(['dns', 'dev']).default('dev'),

  // ---- Email ------------------------------------------------------------------------------
  SMTP_URL: z.string().default('smtp://localhost:1025'),
  /** `queue`: hand mail to the worker via BullMQ (default in the stack). `direct`: send inline. */
  MAIL_TRANSPORT: z.enum(['queue', 'direct']).default('direct'),

  // ---- Integrations ---------------------------------------------------------------------
  /** Key Vault for `kv:` secret refs (managed identity). */
  KEY_VAULT_URL: z.string().optional(),
  MAIL_FROM: z.string().default('ResourceHub <no-reply@resourcehub.local>'),

  // ---- Abuse protection -------------------------------------------------------------------
  RATE_LIMIT_PER_IP_PER_MINUTE: z.coerce.number().int().default(600),
  RATE_LIMIT_PER_TENANT_PER_MINUTE: z.coerce.number().int().default(6000),
  /** Sign-in, refresh and invitation endpoints get a much tighter per-IP budget. */
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().default(30),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

const DEV_SECRET_PREFIX = 'local-dev-only';

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === 'production') {
    if (config.AUTH_JWT_SECRET.startsWith(DEV_SECRET_PREFIX)) {
      throw new Error('AUTH_JWT_SECRET must be set (from Key Vault) in production');
    }
    if (config.AUTH_PROVIDER === 'dev' && process.env.ALLOW_DEV_IDP_IN_PRODUCTION !== 'true') {
      throw new Error('AUTH_PROVIDER=dev is not allowed in production');
    }
    if (config.DOMAIN_VERIFICATION_MODE === 'dev') {
      throw new Error('DOMAIN_VERIFICATION_MODE=dev is not allowed in production');
    }
  }
  return config;
}
