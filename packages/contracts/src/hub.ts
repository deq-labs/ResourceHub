import { z } from 'zod';

const Slug = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, numbers and dashes');

export const ResourceStatus = z.enum(['draft', 'published', 'archived']);
export type ResourceStatus = z.infer<typeof ResourceStatus>;

// ---- taxonomy ---------------------------------------------------------------------------

export const Category = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  sort: z.number().int(),
  resourceCount: z.number().int(),
});
export type Category = z.infer<typeof Category>;

export const CategoryList = z.object({ data: z.array(Category) });

export const CreateCategory = z.object({
  name: z.string().trim().min(1).max(80),
  slug: Slug.optional(),
  description: z.string().trim().max(300).optional(),
  icon: z.string().trim().max(40).optional(),
  sort: z.number().int().min(0).max(1000).optional(),
});
export type CreateCategory = z.infer<typeof CreateCategory>;
export const UpdateCategory = CreateCategory.partial();
export type UpdateCategory = z.infer<typeof UpdateCategory>;

export const Tag = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  resourceCount: z.number().int(),
});
export type Tag = z.infer<typeof Tag>;
export const TagList = z.object({ data: z.array(Tag) });
export const CreateTag = z.object({ name: z.string().trim().min(1).max(40) });
export type CreateTag = z.infer<typeof CreateTag>;

// ---- resources ----------------------------------------------------------------------------

export const ResourceSummary = z.object({
  id: z.uuid(),
  title: z.string(),
  slug: z.string(),
  summary: z.string().nullable(),
  status: ResourceStatus,
  featured: z.boolean(),
  publishedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
  category: z.object({ id: z.uuid(), name: z.string(), slug: z.string() }).nullable(),
  tags: z.array(z.object({ id: z.uuid(), name: z.string(), slug: z.string() })),
  author: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  source: z
    .object({ system: z.string(), externalId: z.string(), url: z.string().nullable() })
    .nullable(),
});
export type ResourceSummary = z.infer<typeof ResourceSummary>;

export const FileInfo = z.object({
  id: z.uuid(),
  filename: z.string(),
  mime: z.string(),
  size: z.number().int(),
  status: z.enum(['pending', 'ready']),
  createdAt: z.iso.datetime(),
});
export type FileInfo = z.infer<typeof FileInfo>;

export const Resource = ResourceSummary.extend({
  body: z.object({ format: z.literal('markdown'), content: z.string() }),
  attachments: z.array(FileInfo),
});
export type Resource = z.infer<typeof Resource>;

export const ResourcePage = z.object({
  data: z.array(ResourceSummary),
  nextCursor: z.string().nullable(),
});
export type ResourcePage = z.infer<typeof ResourcePage>;

export const ResourceQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(200).optional(),
  'filter[status]': ResourceStatus.optional(),
  'filter[category]': z.string().max(80).optional(),
  'filter[tag]': z.string().max(80).optional(),
  'filter[featured]': z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ResourceQuery = z.infer<typeof ResourceQuery>;

export const CreateResource = z.object({
  title: z.string().trim().min(3).max(160),
  slug: Slug.optional(),
  summary: z.string().trim().max(400).optional(),
  body: z.string().max(100_000).default(''),
  status: ResourceStatus.default('draft'),
  featured: z.boolean().default(false),
  categoryId: z.uuid().nullable().optional(),
  tagIds: z.array(z.uuid()).max(20).default([]),
});
export type CreateResource = z.input<typeof CreateResource>;

export const UpdateResource = z.object({
  title: z.string().trim().min(3).max(160).optional(),
  slug: Slug.optional(),
  summary: z.string().trim().max(400).nullable().optional(),
  body: z.string().max(100_000).optional(),
  status: ResourceStatus.optional(),
  featured: z.boolean().optional(),
  categoryId: z.uuid().nullable().optional(),
  tagIds: z.array(z.uuid()).max(20).optional(),
});
export type UpdateResource = z.infer<typeof UpdateResource>;

// ---- files ----------------------------------------------------------------------------------

export const ALLOWED_UPLOAD_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const CreateUpload = z.object({
  filename: z.string().trim().min(1).max(200),
  mime: z.enum(ALLOWED_UPLOAD_TYPES),
  size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  resourceId: z.uuid().optional(),
  purpose: z.enum(['attachment', 'logo']).default('attachment'),
});
export type CreateUpload = z.input<typeof CreateUpload>;

export const UploadTicket = z.object({
  file: FileInfo,
  /** Short-lived, write-only SAS URL for exactly this blob. PUT the bytes here. */
  uploadUrl: z.url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type UploadTicket = z.infer<typeof UploadTicket>;

export const DownloadLink = z.object({ url: z.url(), expiresAt: z.iso.datetime() });
export type DownloadLink = z.infer<typeof DownloadLink>;

// ---- branding & domains ------------------------------------------------------------------

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a #RRGGBB color');

/** Fonts are limited to an allowlist served from Google Fonts (and allowed by the SPA's CSP). */
export const BRAND_FONTS = [
  'Inter',
  'IBM Plex Sans',
  'Nunito Sans',
  'Source Sans 3',
  'Work Sans',
  'Lora',
  'Merriweather',
] as const;

export const Branding = z.object({
  tenant: z.object({ name: z.string(), slug: z.string() }),
  hubTitle: z.string(),
  tagline: z.string().nullable(),
  colors: z.object({
    primary: Hex,
    primaryForeground: Hex,
    accent: Hex,
    background: Hex,
  }),
  font: z.enum(BRAND_FONTS),
  logoUrl: z.string().nullable(),
});
export type Branding = z.infer<typeof Branding>;

export const UpdateBranding = z.object({
  hubTitle: z.string().trim().min(1).max(80).optional(),
  tagline: z.string().trim().max(200).nullable().optional(),
  colors: Branding.shape.colors.optional(),
  font: z.enum(BRAND_FONTS).optional(),
  logoFileId: z.uuid().nullable().optional(),
});
export type UpdateBranding = z.infer<typeof UpdateBranding>;

export const Domain = z.object({
  id: z.uuid(),
  hostname: z.string(),
  verified: z.boolean(),
  verifiedAt: z.iso.datetime().nullable(),
  isPrimary: z.boolean(),
  /** Create this DNS TXT record to prove ownership. */
  verification: z.object({ type: z.literal('TXT'), name: z.string(), value: z.string() }),
});
export type Domain = z.infer<typeof Domain>;
export const DomainList = z.object({ data: z.array(Domain) });

export const CreateDomain = z.object({
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(
      /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/,
      'a valid hostname',
    ),
});
export type CreateDomain = z.infer<typeof CreateDomain>;
