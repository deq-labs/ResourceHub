import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { IntegrationError } from './types.js';

/**
 * `integrations.secret_ref` points at a secret; it is never the secret.
 *   env:NAME          -> process.env.NAME          (local dev only)
 *   kv:secret-name    -> Azure Key Vault, read with the worker's managed identity
 */
export const SECRET_REF_RE = /^(env:[A-Z][A-Z0-9_]{1,63}|kv:[a-zA-Z0-9-]{1,127})$/;

export class SecretResolver {
  private kv?: SecretClient;
  private readonly cache = new Map<string, { value: string; expires: number }>();

  constructor(private readonly opts: { keyVaultUrl?: string; allowEnv: boolean; ttlMs?: number }) {}

  async resolve(ref: string | null | undefined): Promise<string | undefined> {
    if (!ref) return undefined;
    if (!SECRET_REF_RE.test(ref))
      throw new IntegrationError('config', 'Malformed secret reference', false);
    const hit = this.cache.get(ref);
    if (hit && hit.expires > Date.now()) return hit.value;

    let value: string | undefined;
    if (ref.startsWith('env:')) {
      if (!this.opts.allowEnv)
        throw new IntegrationError('config', 'env: secret refs are disabled here', false);
      value = process.env[ref.slice(4)];
    } else {
      if (!this.opts.keyVaultUrl)
        throw new IntegrationError('config', 'Key Vault is not configured', false);
      this.kv ??= new SecretClient(this.opts.keyVaultUrl, new DefaultAzureCredential());
      value = (await this.kv.getSecret(ref.slice(3))).value;
    }
    if (!value) throw new IntegrationError('config', `Secret ${ref} is empty or missing`, false);
    this.cache.set(ref, { value, expires: Date.now() + (this.opts.ttlMs ?? 5 * 60_000) });
    return value;
  }
}
