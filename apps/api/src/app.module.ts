import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { APP_CONFIG } from './tokens.js';
import type { AppConfig } from './config.js';
import { HealthController } from './health.controller.js';
import { InfraModule } from './infra/infra.module.js';
import { TenantsModule } from './modules/tenants/tenants.module.js';
import { HostScopeGuard } from './common/host-scope.js';
import { ProblemDetailsFilter } from './common/problem.js';
import { TenantContextInterceptor } from './common/tenant-context.interceptor.js';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [InfraModule, TenantsModule],
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        // Guard order matters: host scope (404 unknown host) runs before auth.
        { provide: APP_GUARD, useClass: HostScopeGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
      exports: [APP_CONFIG],
    };
  }
}
