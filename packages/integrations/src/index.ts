export * from './types.js';
export * from './resilience/retry.js';
export * from './resilience/circuit-breaker.js';
export { RestClient, type RestClientOptions } from './rest/http.js';
export { callSoap, wsdlPath, type SoapSecurity } from './soap/client.js';
export * from './providers/partner-docs.js';
export * from './providers/country-info.js';
export * from './providers/rest-feeds.js';
export * from './catalog.js';
export * from './secrets.js';

/** BullMQ queue names shared by the API (producer) and the worker (consumer). */
export const QUEUES = { sync: 'integration-sync', email: 'email' } as const;

export interface SyncJob {
  type: 'sync' | 'push';
  /** Jobs always carry their tenant; the worker opens its own withTenantTx() for it. */
  tenantId: string;
  integrationId: string;
  runId: string;
  trigger: 'manual' | 'schedule';
  resourceId?: string;
  requestedBy?: string | null;
}

export interface EmailJob {
  tenantId: string | null;
  to: string;
  subject: string;
  text: string;
  html: string;
}
