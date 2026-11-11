import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { APP_CONFIG } from './tokens.js';
import type { AppConfig } from './config.js';
import { HealthController } from './health.controller.js';
import { InfraModule } from './infra/infra.module.js';
import { TenantsModule } from './modules/tenants/tenants.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { DevIdpModule } from './modules/dev-idp/dev-idp.module.js';
import { AuthGuard } from './common/auth.guard.js';
import { HostScopeGuard } from './common/host-scope.js';
import { ProblemDetailsFilter } from './common/problem.js';
import { RolesGuard } from './common/roles.js';
import { TenantContextInterceptor } from './common/tenant-context.interceptor.js';
import { TenantRateLimitGuard } from './common/tenant-rate-limit.guard.js';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        InfraModule,
        AuditModule,
        TenantsModule,
        AuthModule,
        ...(config.AUTH_PROVIDER === 'dev' ? [DevIdpModule] : []),
      ],
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        // Guard order is the isolation story: host (404) -> per-tenant budget -> auth/membership (401/403) -> role.
        { provide: APP_GUARD, useClass: HostScopeGuard },
        { provide: APP_GUARD, useClass: TenantRateLimitGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
      ],
      exports: [APP_CONFIG],
    };
  }
}
