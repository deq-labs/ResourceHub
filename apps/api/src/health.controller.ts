import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@resourcehub/contracts';

@Controller('health')
export class HealthController {
  @Get()
  get(): HealthResponse {
    return { status: 'ok', version: process.env.APP_VERSION ?? 'dev' };
  }
}
