import { Controller, Get, Req } from '@nestjs/common';
import { CurrentTenant } from '@resourcehub/contracts';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../common/public.decorator.js';
import { problems } from '../../common/problem.js';

class CurrentTenantDto extends createZodDto(CurrentTenant) {}

@Controller('tenant')
export class TenantsController {
  /** Public: the SPA calls this at boot to learn which workspace it is on. */
  @Public()
  @Get()
  @ZodResponse({ status: 200, type: CurrentTenantDto })
  current(@Req() req: FastifyRequest) {
    if (req.site.kind !== 'tenant') throw problems.unknownHost();
    const { id, slug, name } = req.site.tenant;
    return { id, slug, name };
  }
}
