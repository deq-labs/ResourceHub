import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ProblemDetails } from '@resourcehub/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { trace } from '@opentelemetry/api';

const TYPE_BASE = 'https://resourcehub.dev/problems/';

/** Throw this for any expected failure; it renders as RFC 9457 Problem Details. */
export class ProblemException extends HttpException {
  constructor(
    status: number,
    readonly problemType: string,
    title: string,
    detail?: string,
    readonly errors?: { path: string; message: string }[],
  ) {
    super({ title, detail }, status);
  }
}

export const problems = {
  notFound: (detail = 'The requested resource does not exist.') =>
    new ProblemException(404, 'not-found', 'Not Found', detail),
  unknownHost: () =>
    new ProblemException(404, 'unknown-host', 'Unknown host', 'No tenant is served at this host.'),
  tenantSuspended: () =>
    new ProblemException(
      403,
      'tenant-suspended',
      'Tenant suspended',
      'This workspace is suspended.',
    ),
  unauthorized: (detail = 'Sign in to continue.') =>
    new ProblemException(401, 'unauthorized', 'Unauthorized', detail),
  forbidden: (detail = 'You do not have access to this resource.') =>
    new ProblemException(403, 'forbidden', 'Forbidden', detail),
  conflict: (detail: string) => new ProblemException(409, 'conflict', 'Conflict', detail),
  badRequest: (detail: string) => new ProblemException(400, 'bad-request', 'Bad Request', detail),
};

function statusTitle(status: number): string {
  const name = HttpStatus[status];
  return typeof name === 'string'
    ? name
        .toLowerCase()
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
    : 'Error';
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemDetails');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();
    const problem = this.toProblem(exception);
    // The OpenTelemetry trace id when tracing is on (searchable in App Insights), else the request id.
    problem.traceId = trace.getActiveSpan()?.spanContext().traceId ?? req.id;
    if (problem.status >= 500) {
      this.logger.error({ err: exception, traceId: req.id }, 'Unhandled error');
    }
    void reply
      .status(problem.status)
      .header('content-type', 'application/problem+json')
      .send(problem);
  }

  private toProblem(exception: unknown): ProblemDetails {
    if (exception instanceof ProblemException) {
      const body = exception.getResponse() as { title: string; detail?: string };
      return {
        type: TYPE_BASE + exception.problemType,
        title: body.title,
        status: exception.getStatus(),
        ...(body.detail ? { detail: body.detail } : {}),
        ...(exception.errors ? { errors: exception.errors } : {}),
      };
    }
    const zod = findZodError(exception);
    if (zod) {
      return {
        type: TYPE_BASE + 'validation',
        title: 'Validation failed',
        status: 400,
        detail: 'One or more fields are invalid.',
        errors: zod.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const detail =
        typeof res === 'string'
          ? res
          : typeof (res as { message?: unknown }).message === 'string'
            ? (res as { message: string }).message
            : undefined;
      return {
        type: TYPE_BASE + statusTitle(status).toLowerCase().replaceAll(' ', '-'),
        title: statusTitle(status),
        status,
        ...(detail ? { detail } : {}),
      };
    }
    return {
      type: TYPE_BASE + 'internal',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Something went wrong. Quote the traceId when reporting this.',
    };
  }
}

function findZodError(e: unknown): ZodError | undefined {
  if (e instanceof ZodError) return e;
  const maybe = e as { getZodError?: () => unknown } | null;
  if (maybe && typeof maybe.getZodError === 'function') {
    const inner = maybe.getZodError();
    if (inner instanceof ZodError) return inner;
  }
  return undefined;
}
