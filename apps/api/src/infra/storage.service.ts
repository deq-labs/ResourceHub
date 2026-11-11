import { Inject, Injectable, Logger } from '@nestjs/common';
import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobSASPermissions,
  BlobServiceClient,
  type ContainerClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
  type UserDelegationKey,
} from '@azure/storage-blob';
import { requireTenantContext } from '@resourcehub/db';
import { APP_CONFIG } from '../tokens.js';
import type { AppConfig } from '../config.js';

export interface BlobProps {
  size: number;
  contentType: string | undefined;
  md5: string | undefined;
}

/**
 * Azure Blob Storage with per-tenant prefixes. Every path is `tenants/{tenantId}/...`, and this
 * service refuses to sign a URL for any path outside the CURRENT tenant's prefix (from the
 * AsyncLocalStorage context). SAS URLs are per blob, short-lived and least-privilege.
 *
 * Locally (Azurite) it signs with the account key; in Azure it uses a user-delegation key
 * obtained with the Container App's managed identity, so no storage key exists anywhere.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly service: BlobServiceClient;
  private readonly container: ContainerClient;
  private readonly sharedKey?: StorageSharedKeyCredential;
  private delegation?: { key: UserDelegationKey; expires: number };

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    if (config.STORAGE_ACCOUNT_URL) {
      this.service = new BlobServiceClient(
        config.STORAGE_ACCOUNT_URL,
        new DefaultAzureCredential(),
      );
    } else {
      this.service = BlobServiceClient.fromConnectionString(config.STORAGE_CONNECTION_STRING);
      const cred = this.service.credential;
      if (cred instanceof StorageSharedKeyCredential) this.sharedKey = cred;
    }
    this.container = this.service.getContainerClient(config.STORAGE_CONTAINER);
  }

  /** Called once at boot (not in tests/openapi generation). Creates the private container. */
  async ensureReady(): Promise<void> {
    try {
      await this.container.createIfNotExists();
      if (this.config.NODE_ENV !== 'production' && !this.config.STORAGE_ACCOUNT_URL) {
        // Azurite: allow the SPA (any *.localhost origin) to PUT directly to a SAS URL.
        await this.service.setProperties({
          cors: [
            {
              allowedOrigins: '*',
              allowedMethods: 'GET,PUT,HEAD,OPTIONS',
              allowedHeaders: '*',
              exposedHeaders: '*',
              maxAgeInSeconds: 3600,
            },
          ],
        });
      }
    } catch (err) {
      this.logger.warn(
        { err },
        'blob storage not reachable at startup; uploads will fail until it is',
      );
    }
  }

  static tenantPrefix(tenantId: string): string {
    return `tenants/${tenantId}/`;
  }

  static safeFilename(name: string): string {
    const cleaned = name
      .normalize('NFKD')
      .replace(/[^\w.\- ]+/g, '')
      .replace(/\s+/g, '-')
      .slice(-120);
    return cleaned || 'file';
  }

  static filePath(tenantId: string, fileId: string, filename: string): string {
    return `${StorageService.tenantPrefix(tenantId)}files/${fileId}/${StorageService.safeFilename(filename)}`;
  }

  /** Defence in depth: the DB check constraint enforces the prefix too. */
  private assertOwnPath(path: string): void {
    const { tenantId } = requireTenantContext();
    if (!path.startsWith(StorageService.tenantPrefix(tenantId)) || path.includes('..')) {
      throw new Error('Refusing to touch a blob outside the current tenant prefix');
    }
  }

  private async signer(
    expiresOn: Date,
  ): Promise<(params: Parameters<typeof generateBlobSASQueryParameters>[0]) => string> {
    if (this.sharedKey) {
      const key = this.sharedKey;
      return (p) => generateBlobSASQueryParameters(p, key).toString();
    }
    const now = Date.now();
    if (!this.delegation || this.delegation.expires - now < 15 * 60_000) {
      const start = new Date(now - 5 * 60_000);
      const end = new Date(now + 60 * 60_000);
      const key = await this.service.getUserDelegationKey(start, end);
      this.delegation = { key, expires: end.getTime() };
    }
    if (expiresOn.getTime() > this.delegation.expires)
      throw new Error('SAS outlives delegation key');
    const { key } = this.delegation;
    return (p) => generateBlobSASQueryParameters(p, key, this.service.accountName).toString();
  }

  async signedUrl(
    path: string,
    mode: 'read' | 'write',
    ttlMinutes: number,
    opts: { contentType?: string; downloadName?: string } = {},
  ): Promise<{ url: string; expiresAt: Date }> {
    this.assertOwnPath(path);
    const startsOn = new Date(Date.now() - 2 * 60_000);
    const expiresOn = new Date(Date.now() + ttlMinutes * 60_000);
    const sign = await this.signer(expiresOn);
    const sas = sign({
      containerName: this.config.STORAGE_CONTAINER,
      blobName: path,
      permissions: BlobSASPermissions.parse(mode === 'read' ? 'r' : 'cw'),
      startsOn,
      expiresOn,
      protocol:
        this.config.NODE_ENV === 'production' ? SASProtocol.Https : SASProtocol.HttpsAndHttp,
      ...(opts.contentType ? { contentType: opts.contentType } : {}),
      ...(opts.downloadName
        ? { contentDisposition: `attachment; filename="${opts.downloadName.replace(/"/g, '')}"` }
        : {}),
    });
    return { url: `${this.container.getBlobClient(path).url}?${sas}`, expiresAt: expiresOn };
  }

  async properties(path: string): Promise<BlobProps | null> {
    this.assertOwnPath(path);
    try {
      const p = await this.container.getBlobClient(path).getProperties();
      return {
        size: p.contentLength ?? 0,
        contentType: p.contentType,
        md5: p.contentMD5 ? Buffer.from(p.contentMD5).toString('base64') : undefined,
      };
    } catch {
      return null;
    }
  }

  async delete(path: string): Promise<void> {
    this.assertOwnPath(path);
    await this.container.getBlobClient(path).deleteIfExists();
  }
}
