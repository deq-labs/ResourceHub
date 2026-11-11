import type { z } from 'zod';
import type { CircuitBreaker } from './resilience/circuit-breaker.js';
import type { RetryOptions } from './resilience/retry.js';
import { CountryInfoAdapter, CountryInfoConfig } from './providers/country-info.js';
import { PartnerDocsAdapter, PartnerDocsConfig } from './providers/partner-docs.js';
import {
  PartnerFeedAdapter,
  PartnerFeedConfig,
  SpaceflightNewsAdapter,
  SpaceflightNewsConfig,
} from './providers/rest-feeds.js';
import type { ExternalDocument, IntegrationAdapter, WithSecret } from './types.js';

export interface AdapterDeps {
  breaker?: CircuitBreaker;
  retry?: RetryOptions;
}

export interface ProviderDefinition {
  provider: string;
  kind: 'rest' | 'soap';
  label: string;
  description: string;
  /** Validates `integrations.config` (never holds secrets). */
  configSchema: z.ZodType<Record<string, unknown>>;
  /** Whether a secret_ref is required (password/token/client certificate). */
  needsSecret: boolean;
  supportsPush: boolean;
  defaults: Record<string, unknown>;
  create(
    deps: AdapterDeps,
  ): IntegrationAdapter<WithSecret<Record<string, unknown>>, ExternalDocument>;
}

type AnyAdapter = IntegrationAdapter<WithSecret<Record<string, unknown>>, ExternalDocument>;
const as = (a: unknown) => a as AnyAdapter;

/** The integrations a tenant admin can configure. Adding a partner = one adapter + one entry. */
export const PROVIDERS: ProviderDefinition[] = [
  {
    provider: 'partner-docs',
    kind: 'soap',
    label: 'Partner document library (SOAP)',
    description:
      'Legacy partner system: SOAP 1.1 with WS-Security UsernameToken. Pulls documents, pushes resources back.',
    configSchema: PartnerDocsConfig,
    needsSecret: true,
    supportsPush: true,
    defaults: { endpoint: 'http://localhost:8088/soap/partner-docs', username: 'partner-demo' },
    create: (d) => as(new PartnerDocsAdapter(d)),
  },
  {
    provider: 'partner-feed',
    kind: 'rest',
    label: 'Partner content feed (REST)',
    description:
      'Private REST API with bearer auth and cursor pagination. Retries 429/5xx with jittered backoff.',
    configSchema: PartnerFeedConfig,
    needsSecret: true,
    supportsPush: true,
    defaults: { baseUrl: 'http://localhost:8089' },
    create: (d) => as(new PartnerFeedAdapter(d)),
  },
  {
    provider: 'country-info',
    kind: 'soap',
    label: 'Country profiles (public SOAP)',
    description: 'The public CountryInfoService WSDL. No credentials; full snapshot on each sync.',
    configSchema: CountryInfoConfig,
    needsSecret: false,
    supportsPush: false,
    defaults: {
      endpoint: 'http://webservices.oorsprong.org/websamples.countryinfo/CountryInfoService.wso',
      continent: 'EU',
    },
    create: (d) => as(new CountryInfoAdapter(d)),
  },
  {
    provider: 'spaceflight-news',
    kind: 'rest',
    label: 'Industry news (public REST)',
    description: 'The public Spaceflight News API, filtered by updated-since.',
    configSchema: SpaceflightNewsConfig,
    needsSecret: false,
    supportsPush: false,
    defaults: { baseUrl: 'https://api.spaceflightnewsapi.net', maxItems: 20 },
    create: (d) => as(new SpaceflightNewsAdapter(d)),
  },
];

export function getProvider(provider: string): ProviderDefinition | undefined {
  return PROVIDERS.find((p) => p.provider === provider);
}
