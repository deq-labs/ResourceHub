import { Controller, Get, Req } from '@nestjs/common';
import type { CurrentTenant } from '@resourcehub/contracts';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../common/public.decorator.js';
import { problems } from '../../common/problem.js';

@Controller('tenant')
export class TenantsController {
  /** Public: the SPA calls this at boot to learn which workspace it is on. */
  @Public()
  @Get()
  current(@Req() req: FastifyRequest): CurrentTenant {
    if (req.site.kind !== 'tenant') throw problems.unknownHost();
    const { id, slug, name } = req.site.tenant;
    return { id, slug, name };
  }
}
