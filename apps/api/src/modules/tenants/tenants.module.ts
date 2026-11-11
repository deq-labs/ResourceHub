import { Module } from '@nestjs/common';
import { TenantResolverService } from './tenant-resolver.service.js';
import { TenantsController } from './tenants.controller.js';

@Module({
  controllers: [TenantsController],
  providers: [TenantResolverService],
  exports: [TenantResolverService],
})
export class TenantsModule {}
