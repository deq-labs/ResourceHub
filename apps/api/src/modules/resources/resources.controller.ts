import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateResource,
  Resource,
  ResourcePage,
  ResourceQuery,
  UpdateResource,
} from '@resourcehub/contracts';
import type { FastifyRequest } from 'fastify';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { Idempotent } from '../../common/idempotency.interceptor.js';
import { authOf, tenantOf } from '../../common/request.js';
import { Roles } from '../../common/roles.js';
import { StorageService } from '../../infra/storage.service.js';
import { actorFrom } from '../audit/audit.service.js';
import { ResourcesService } from './resources.service.js';

class ResourceQueryDto extends createZodDto(ResourceQuery) {}
class ResourcePageDto extends createZodDto(ResourcePage) {}
class ResourceDto extends createZodDto(Resource) {}
class CreateResourceDto extends createZodDto(CreateResource) {}
class UpdateResourceDto extends createZodDto(UpdateResource) {}

@ApiTags('resources')
@Controller('resources')
export class ResourcesController {
  constructor(
    private readonly resources: ResourcesService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  @ZodResponse({ status: 200, type: ResourcePageDto })
  list(@Req() req: FastifyRequest, @Query() query: ResourceQueryDto) {
    return this.resources.list(query, authOf(req).role);
  }

  /** By id or slug. Viewers get 404 for anything that isn't published. */
  @Get(':idOrSlug')
  @ZodResponse({ status: 200, type: ResourceDto })
  get(@Req() req: FastifyRequest, @Param('idOrSlug') idOrSlug: string) {
    return this.resources.get(idOrSlug.slice(0, 100), authOf(req).role);
  }

  @Post()
  @Roles('editor')
  @Idempotent()
  @ZodResponse({ status: 201, type: ResourceDto })
  create(@Req() req: FastifyRequest, @Body() body: CreateResourceDto) {
    return this.resources.create(tenantOf(req).id, authOf(req).id, actorFrom(req), body);
  }

  @Patch(':id')
  @Roles('editor')
  @ZodResponse({ status: 200, type: ResourceDto })
  update(
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateResourceDto,
  ) {
    return this.resources.update(tenantOf(req).id, id, actorFrom(req), body);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(204)
  async remove(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    const { blobPaths } = await this.resources.remove(tenantOf(req).id, id, actorFrom(req));
    await Promise.allSettled(blobPaths.map((p) => this.storage.delete(p)));
  }
}
