import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { IdentityService } from './identity.service.js';
import { OidcClient } from './oidc.client.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';
import { MeController } from '../users/me.controller.js';
import { InvitationsController } from '../invitations/invitations.controller.js';
import { InvitationsService } from '../invitations/invitations.service.js';

@Global()
@Module({
  controllers: [AuthController, MeController, InvitationsController],
  providers: [
    TokenService,
    OidcClient,
    IdentityService,
    SessionService,
    AuthService,
    InvitationsService,
  ],
  exports: [TokenService, IdentityService, SessionService, AuthService],
})
export class AuthModule {}
