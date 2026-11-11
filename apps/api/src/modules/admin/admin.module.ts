import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { PlatformController } from '../platform/platform.controller.js';
import { TenantsModule } from '../tenants/tenants.module.js';

/** Tenant admin (members, audit) and the platform console API (admin host only). */
@Module({
  imports: [TenantsModule],
  controllers: [AdminController, PlatformController],
})
export class AdminModule {}
