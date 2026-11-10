import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'resourcehub:public';

/** Opt a route out of authentication. Deny-by-default: everything else needs a valid token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
