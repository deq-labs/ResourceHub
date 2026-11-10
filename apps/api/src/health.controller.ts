import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@resourcehub/contracts';
import { ForHost } from './common/host-scope.js';
import { Public } from './common/public.decorator.js';

@Controller('health')
@ForHost('any')
@Public()
export class HealthController {
  @Get()
  get(): HealthResponse {
    return { status: 'ok', version: process.env.APP_VERSION ?? 'dev' };
  }
}
