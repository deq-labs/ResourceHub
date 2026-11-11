import { z } from 'zod';

/** RFC 9457 Problem Details: the only error shape the API returns. */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  traceId: z.string().optional(),
  errors: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional()
    .describe('Field-level validation errors'),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

export const HealthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const Uuid = z.uuid();

/** Cursor pagination: `?cursor=&limit=` with a hard cap of 100. */
export const PageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof PageQuery>;

export function page<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
