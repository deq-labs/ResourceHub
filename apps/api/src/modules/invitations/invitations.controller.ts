import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import {
  AcceptInvitation,
  CreatedInvitation,
  CreateInvitation,
  InvitationList,
  InvitationPreview,
} from '@resourcehub/contracts';
import type { FastifyRequest } from 'fastify';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { AllowNonMember } from '../../common/auth.guard.js';
import { Idempotent } from '../../common/idempotency.interceptor.js';
import { Public } from '../../common/public.decorator.js';
import { Roles } from '../../common/roles.js';
import { tenantOf } from '../../common/request.js';
import { actorFrom } from '../audit/audit.service.js';
import { InvitationsService } from './invitations.service.js';

class CreateInvitationDto extends createZodDto(CreateInvitation) {}
class AcceptInvitationDto extends createZodDto(AcceptInvitation) {}
class CreatedInvitationDto extends createZodDto(CreatedInvitation) {}
class InvitationListDto extends createZodDto(InvitationList) {}
class InvitationPreviewDto extends createZodDto(InvitationPreview) {}
class AcceptedDto extends createZodDto(
  z.object({ role: z.enum(['owner', 'admin', 'editor', 'viewer']) }),
) {}
class PreviewQueryDto extends createZodDto(z.object({ token: z.string().min(20).max(200) })) {}

const strict = { rateTier: 'auth' };

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  @Roles('admin')
  @ZodResponse({ status: 200, type: InvitationListDto })
  async list() {
    return { data: await this.invitations.list() };
  }

  @Post()
  @Roles('admin')
  @Idempotent()
  @ZodResponse({ status: 201, type: CreatedInvitationDto })
  create(@Req() req: FastifyRequest, @Body() body: CreateInvitationDto) {
    return this.invitations.create(tenantOf(req), req.host, req.auth!, actorFrom(req), body);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(204)
  async revoke(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.invitations.revoke(id, tenantOf(req).id, actorFrom(req));
  }

  /** Public, so the invite page can say "join Contoso as editor" before sign-in. */
  @Get('preview')
  @Public()
  @RouteConfig(strict)
  @ZodResponse({ status: 200, type: InvitationPreviewDto })
  preview(@Req() req: FastifyRequest, @Query() query: PreviewQueryDto) {
    return this.invitations.preview(tenantOf(req), query.token, req.ip);
  }

  @Post('accept')
  @AllowNonMember()
  @RouteConfig(strict)
  @HttpCode(200)
  @ZodResponse({ status: 200, type: AcceptedDto })
  accept(@Req() req: FastifyRequest, @Body() body: AcceptInvitationDto) {
    return this.invitations.accept(tenantOf(req), req.auth!, actorFrom(req), body.token);
  }
}
