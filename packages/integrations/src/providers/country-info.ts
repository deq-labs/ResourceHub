import { z } from 'zod';
import type { CircuitBreaker } from '../resilience/circuit-breaker.js';
import type { RetryOptions } from '../resilience/retry.js';
import { callSoap, type SoapCallOptions } from '../soap/client.js';
import {
  err,
  ExternalDocument,
  IntegrationError,
  ok,
  type IntegrationAdapter,
  type WithSecret,
} from '../types.js';

export const CountryInfoConfig = z.object({
  endpoint: z
    .url()
    .default('http://webservices.oorsprong.org/websamples.countryinfo/CountryInfoService.wso'),
  /** Optional ISO continent filter, e.g. "EU". */
  continent: z.string().length(2).toUpperCase().optional(),
});
export type CountryInfoConfig = z.infer<typeof CountryInfoConfig>;

const Country = z.object({
  sISOCode: z.string(),
  sName: z.string(),
  sCapitalCity: z.string().default(''),
  sPhoneCode: z.string().default(''),
  sContinentCode: z.string().default(''),
  sCurrencyISOCode: z.string().default(''),
  sCountryFlag: z.string().default(''),
  Languages: z
    .object({
      tLanguage: z
        .union([z.object({ sName: z.string() }), z.array(z.object({ sName: z.string() }))])
        .optional(),
    })
    .nullish(),
});
const AllCountries = z.object({
  FullCountryInfoAllCountriesResult: z.object({ tCountryInfo: z.array(Country) }),
});

const CONTINENTS: Record<string, string> = {
  AF: 'Africa',
  AN: 'Antarctica',
  AS: 'Asia',
  EU: 'Europe',
  OC: 'Oceania',
  AM: 'Americas',
};

export function mapCountry(c: z.infer<typeof Country>, syncedAt: Date): ExternalDocument {
  const langs = c.Languages?.tLanguage;
  const languages = (Array.isArray(langs) ? langs : langs ? [langs] : [])
    .map((l) => l.sName)
    .join(', ');
  return ExternalDocument.parse({
    externalId: c.sISOCode,
    title: `Country fact sheet: ${c.sName}`,
    summary: `Capital ${c.sCapitalCity || 'n/a'} · currency ${c.sCurrencyISOCode || 'n/a'} · dialling +${c.sPhoneCode}`,
    body: [
      `| Field | Value |`,
      `|---|---|`,
      `| ISO code | ${c.sISOCode} |`,
      `| Capital | ${c.sCapitalCity} |`,
      `| Currency | ${c.sCurrencyISOCode} |`,
      `| Phone code | +${c.sPhoneCode} |`,
      `| Languages | ${languages || 'n/a'} |`,
      '',
      '_Synced from the public CountryInfoService SOAP API._',
    ].join('\n'),
    category: `Country profiles · ${CONTINENTS[c.sContinentCode] ?? c.sContinentCode}`.slice(0, 80),
    url: c.sCountryFlag.startsWith('http') ? c.sCountryFlag : null,
    updatedAt: syncedAt,
  });
}

/**
 * Public SOAP demo (no credentials): the CountryInfoService. Shows that a real third-party
 * WSDL, committed to the repo, maps cleanly into the same domain type as a private partner.
 */
export class CountryInfoAdapter implements IntegrationAdapter<
  WithSecret<CountryInfoConfig>,
  ExternalDocument
> {
  readonly kind = 'soap' as const;

  constructor(private readonly deps: { breaker?: CircuitBreaker; retry?: RetryOptions } = {}) {}

  private opts(cfg: CountryInfoConfig): SoapCallOptions {
    return {
      wsdl: 'country-info.wsdl',
      endpoint: cfg.endpoint,
      security: { type: 'none' },
      timeoutMs: 20_000,
      ...(this.deps.breaker ? { breaker: this.deps.breaker } : {}),
      ...(this.deps.retry ? { retry: this.deps.retry } : {}),
    };
  }

  async testConnection(cfg: WithSecret<CountryInfoConfig>) {
    try {
      await callSoap(this.opts(cfg), 'CapitalCity', { sCountryISOCode: 'NL' });
      return ok(undefined);
    } catch (e) {
      return err(
        e instanceof IntegrationError
          ? e
          : new IntegrationError('invalid_response', String(e), false),
      );
    }
  }

  /** The service has no change feed, so every sync is a full snapshot; upserts make it idempotent. */
  async *fetchChanges(cfg: WithSecret<CountryInfoConfig>): AsyncIterable<ExternalDocument> {
    const parsed = AllCountries.safeParse(
      await callSoap(this.opts(cfg), 'FullCountryInfoAllCountries', {}),
    );
    if (!parsed.success)
      throw new IntegrationError(
        'invalid_response',
        'Unexpected FullCountryInfoAllCountries payload',
        false,
      );
    const now = new Date();
    for (const c of parsed.data.FullCountryInfoAllCountriesResult.tCountryInfo) {
      if (!cfg.continent || c.sContinentCode === cfg.continent) yield mapCountry(c, now);
    }
  }

  push() {
    return Promise.resolve(
      err(new IntegrationError('config', 'CountryInfoService is read-only', false)),
    );
  }
}
