import { Module } from '@nestjs/common';
import { DevIdpController } from './dev-idp.controller.js';
import { DevIdpService } from './dev-idp.service.js';

@Module({
  controllers: [DevIdpController],
  providers: [DevIdpService],
})
export class DevIdpModule {}
