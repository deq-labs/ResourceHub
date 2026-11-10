import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { DEMO_USERS } from '@resourcehub/db';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ForHost } from '../../common/host-scope.js';
import { Public } from '../../common/public.decorator.js';
import { DevIdpService } from './dev-idp.service.js';
import { renderAuthorizePage, renderError } from './dev-idp.page.js';

const AuthorizeParams = z.object({
  response_type: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  scope: z.string().optional(),
  state: z.string().max(200).optional(),
  nonce: z.string().max(200).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().optional(),
  login_hint: z.string().max(200).optional(),
});
const SignIn = AuthorizeParams.extend({
  oid: z.string().max(100).optional(),
  email: z.email().max(200).optional(),
  name: z.string().trim().max(120).optional(),
});
const TokenRequest = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string(),
  code_verifier: z.string(),
  redirect_uri: z.string(),
  client_id: z.string(),
});

/** Local stand-in for Entra External ID. Only mounted when AUTH_PROVIDER=dev. */
@ApiExcludeController()
@Controller('dev-idp')
@ForHost('any')
@Public()
export class DevIdpController {
  constructor(private readonly idp: DevIdpService) {}

  @Get('.well-known/openid-configuration')
  discovery() {
    return this.idp.discovery();
  }

  @Get('jwks')
  jwks() {
    return this.idp.jwks();
  }

  @Get('authorize')
  authorize(@Query() query: unknown, @Res() reply: FastifyReply) {
    const params = AuthorizeParams.parse(query);
    const error = this.idp.validateAuthorizeRequest(params);
    void reply.header('content-security-policy', this.idp.pageCsp).type('text/html; charset=utf-8');
    if (error) return reply.status(400).send(renderError(error));
    return reply.send(renderAuthorizePage(this.idp.issuer, params, DEMO_USERS));
  }

  @Post('authorize')
  signIn(@Body() body: unknown, @Res() reply: FastifyReply) {
    const p = SignIn.parse(body);
    const error = this.idp.validateAuthorizeRequest(p);
    if (error) {
      return reply
        .status(400)
        .header('content-security-policy', this.idp.pageCsp)
        .type('text/html')
        .send(renderError(error));
    }
    let identity: { sub: string; email: string; name: string } | undefined;
    if (p.oid) {
      const u = DEMO_USERS.find((d) => d.oid === p.oid);
      if (u) identity = { sub: u.oid, email: u.email, name: u.name };
    } else if (p.email) {
      identity = {
        sub: DevIdpService.subjectForEmail(p.email),
        email: p.email.toLowerCase(),
        name: p.name || p.email.split('@')[0]!,
      };
    }
    if (!identity) {
      return reply
        .status(400)
        .header('content-security-policy', this.idp.pageCsp)
        .type('text/html')
        .send(renderError('Pick a user'));
    }
    const code = this.idp.issueCode({
      ...identity,
      nonce: p.nonce!,
      challenge: p.code_challenge!,
      redirectUri: p.redirect_uri!,
      clientId: p.client_id!,
    });
    const target = new URL(p.redirect_uri!);
    target.searchParams.set('code', code);
    target.searchParams.set('state', p.state!);
    return reply.redirect(target.toString(), 302);
  }

  @Post('token')
  @HttpCode(200)
  async token(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const parsed = TokenRequest.safeParse(body);
    const result = parsed.success
      ? await this.idp.redeem({
          code: parsed.data.code,
          codeVerifier: parsed.data.code_verifier,
          redirectUri: parsed.data.redirect_uri,
          clientId: parsed.data.client_id,
        })
      : null;
    void reply.header('cache-control', 'no-store');
    if (!result) {
      void reply.status(400);
      return { error: 'invalid_grant' };
    }
    return result;
  }
}
