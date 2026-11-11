import { Controller, Get } from '@nestjs/common';
import { HealthResponse } from '@resourcehub/contracts';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { ForHost } from './common/host-scope.js';
import { Public } from './common/public.decorator.js';

class HealthDto extends createZodDto(HealthResponse) {}

@Controller('health')
@ForHost('any')
@Public()
export class HealthController {
  @Get()
  @ZodResponse({ status: 200, type: HealthDto })
  get() {
    return { status: 'ok' as const, version: process.env.APP_VERSION ?? 'dev' };
  }
}
