import type { StatusCode } from 'hono/utils/http-status';

/**
 * Yggdrasil errors all share the same body shape. Clients (and
 * authlib-injector) surface `errorMessage` to the player, so the wording
 * matters more than usual.
 */
export class YggdrasilError extends Error {
  constructor(
    readonly status: StatusCode,
    readonly error: string,
    readonly errorMessage: string,
    readonly cause?: string,
  ) {
    super(errorMessage);
  }

  toResponse(): Response {
    const body: Record<string, string> = { error: this.error, errorMessage: this.errorMessage };
    if (this.cause) body.cause = this.cause;
    return Response.json(body, { status: this.status });
  }
}

export const invalidCredentials = () =>
  new YggdrasilError(
    403,
    'ForbiddenOperationException',
    'Invalid credentials. Invalid username or password.',
  );

export const invalidToken = () =>
  new YggdrasilError(403, 'ForbiddenOperationException', 'Invalid token.');

export const badRequest = (message: string) =>
  new YggdrasilError(400, 'IllegalArgumentException', message);

export const forbidden = (message: string) =>
  new YggdrasilError(403, 'ForbiddenOperationException', message);
