import { Module } from '@nestjs/common';
import { BrandingController } from './branding/branding.controller.js';
import { BrandingService } from './branding/branding.service.js';
import { DomainsController } from './domains/domains.controller.js';
import { FilesController } from './files/files.controller.js';
import { ResourcesController } from './resources/resources.controller.js';
import { ResourcesService } from './resources/resources.service.js';
import { TaxonomyController } from './resources/taxonomy.controller.js';
import { TenantsModule } from './tenants/tenants.module.js';

/** The tenant-facing resource hub: content, taxonomy, files, branding, custom domains. */
@Module({
  imports: [TenantsModule],
  controllers: [
    ResourcesController,
    TaxonomyController,
    FilesController,
    BrandingController,
    DomainsController,
  ],
  providers: [ResourcesService, BrandingService],
  exports: [ResourcesService, BrandingService],
})
export class HubModule {}
