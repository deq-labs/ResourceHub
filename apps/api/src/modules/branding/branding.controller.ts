import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Branding, UpdateBranding } from '@resourcehub/contracts';
import type { FastifyRequest } from 'fastify';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { Public } from '../../common/public.decorator.js';
import { tenantOf } from '../../common/request.js';
import { Roles } from '../../common/roles.js';
import { actorFrom } from '../audit/audit.service.js';
import { BrandingService } from './branding.service.js';

class BrandingDto extends createZodDto(Branding) {}
class UpdateBrandingDto extends createZodDto(UpdateBranding) {}

@ApiTags('branding')
@Controller('branding')
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  /** Public: the SPA needs the theme before anyone signs in. */
  @Get()
  @Public()
  @ZodResponse({ status: 200, type: BrandingDto })
  get(@Req() req: FastifyRequest) {
    return this.branding.get(tenantOf(req));
  }

  @Put()
  @Roles('admin')
  @ZodResponse({ status: 200, type: BrandingDto })
  update(@Req() req: FastifyRequest, @Body() body: UpdateBrandingDto) {
    return this.branding.update(tenantOf(req), actorFrom(req), body);
  }
}
