import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import soap from 'soap';
import { CircuitBreaker } from '../resilience/circuit-breaker.js';
import { DEFAULT_RETRY, withRetry, type RetryOptions } from '../resilience/retry.js';
import { IntegrationError } from '../types.js';
import { assertEgressAllowed } from '../resilience/egress.js';

/** WSDLs are committed to the repo and read from disk: no runtime fetch of a partner's WSDL. */
export const wsdlPath = (name: string) =>
  fileURLToPath(new URL(`../../wsdl/${name}`, import.meta.url));

export type SoapSecurity =
  | { type: 'none' }
  | { type: 'username-token'; username: string; password: string; digest?: boolean }
  /** Mutual TLS: PEM key + cert (from Key Vault in Azure). */
  | { type: 'client-cert'; keyPem: string; certPem: string };

export interface SoapCallOptions {
  wsdl: string;
  endpoint: string;
  security: SoapSecurity;
  timeoutMs?: number;
  retry?: RetryOptions;
  breaker?: CircuitBreaker;
}

type SoapMethod = (args: unknown, opts: { timeout: number }) => Promise<[unknown, string]>;

/**
 * A fresh client per call: the WSDL is a local file (cheap to parse), and a shared client would
 * let two integrations with different credentials race on setSecurity().
 */
function getClient(wsdl: string, endpoint: string): Promise<soap.Client> {
  return soap.createClientAsync(wsdlPath(wsdl), { endpoint });
}

function applySecurity(client: soap.Client, s: SoapSecurity): void {
  if (s.type === 'username-token') {
    client.setSecurity(
      new soap.WSSecurity(s.username, s.password, {
        passwordType: s.digest ? 'PasswordDigest' : 'PasswordText',
        hasTimeStamp: true,
      }),
    );
  } else if (s.type === 'client-cert') {
    client.setSecurity(
      new soap.ClientSSLSecurity(Buffer.from(s.keyPem), Buffer.from(s.certPem), {}),
    );
  }
}

/** Map anything the soap library throws into an IntegrationError. XML stops here. */
function toIntegrationError(e: unknown): IntegrationError {
  if (e instanceof IntegrationError) return e;
  const anyErr = e as {
    response?: { status?: number };
    root?: { Envelope?: { Body?: { Fault?: { faultstring?: string; faultcode?: string } } } };
    code?: string;
    message?: string;
  };
  const fault = anyErr.root?.Envelope?.Body?.Fault;
  const status = anyErr.response?.status;
  const msg = fault?.faultstring ?? anyErr.message ?? 'SOAP call failed';
  if (/auth|security|username|password|credential/i.test(msg) || status === 401 || status === 403)
    return new IntegrationError('auth', `Partner rejected credentials: ${msg}`, false);
  if (anyErr.code === 'ECONNABORTED' || /timeout/i.test(msg))
    return new IntegrationError('timeout', 'Partner timed out', true);
  if (
    anyErr.code === 'ECONNREFUSED' ||
    anyErr.code === 'ENOTFOUND' ||
    (status !== undefined && status >= 500 && !fault)
  )
    return new IntegrationError('unavailable', 'Partner unreachable', true);
  if (fault)
    return new IntegrationError(
      'rejected',
      `Partner fault ${fault.faultcode ?? ''}: ${msg}`.trim(),
      false,
    );
  return new IntegrationError('unavailable', msg, true);
}

/** Call one SOAP operation with timeout, retry and breaker. Returns the parsed JS result. */
export async function callSoap(
  opts: SoapCallOptions,
  operation: string,
  args: unknown,
): Promise<unknown> {
  await assertEgressAllowed(opts.endpoint);
  const call = () =>
    withRetry(async () => {
      try {
        const client = await getClient(opts.wsdl, opts.endpoint);
        applySecurity(client, opts.security);
        const fn = (client as unknown as Record<string, SoapMethod | undefined>)[
          `${operation}Async`
        ];
        if (!fn) throw new IntegrationError('config', `Operation ${operation} not in WSDL`, false);
        const [result] = await fn.call(client, args, { timeout: opts.timeoutMs ?? 15_000 });
        return result;
      } catch (e) {
        throw toIntegrationError(e);
      }
    }, opts.retry ?? DEFAULT_RETRY);
  return opts.breaker ? opts.breaker.exec(call) : call();
}

export function readWsdl(name: string): string {
  return readFileSync(wsdlPath(name), 'utf8');
}
