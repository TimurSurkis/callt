import type { Request, RequestHandler } from 'express';
import type { ProviderAuthAdapter } from '../../modules/calls/service.js';
import { AppError } from '../../shared/core.js';
import { safeEqual } from '../../shared/crypto.js';

export function requireSecret(header: string, secret: string): RequestHandler {
  return (request, _response, next) => {
    if (!safeEqual(request.get(header) ?? '', secret)) throw new AppError(401, 'UNAUTHORIZED');
    next();
  };
}
export class LocalProviderAuth implements ProviderAuthAdapter {
  readonly provider = 'local';
  constructor(private secret: string) {}
  verify(request: Request) {
    if (!safeEqual(request.get('x-webhook-secret') ?? '', this.secret)) throw new AppError(401, 'UNAUTHORIZED');
  }
}
