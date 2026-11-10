import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import { cleanupOpenApiDoc } from 'nestjs-zod';

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('ResourceHub API')
    .setDescription(
      'Multi-tenant resource hub. The tenant is implied by the Host header (never in the URL). ' +
        'Errors are RFC 9457 problem+json. Creating POSTs require an Idempotency-Key header.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  return cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
}
