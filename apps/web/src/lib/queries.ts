import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { api, unwrap } from './api';

export interface ResourceFilters {
  q?: string;
  category?: string;
  tag?: string;
  status?: 'draft' | 'published' | 'archived';
  featured?: boolean;
}

export const qk = {
  resources: ['resources'] as const,
  categories: ['categories'] as const,
  tags: ['tags'] as const,
  me: ['me'] as const,
};

export const resourcesQuery = (f: ResourceFilters, limit = 12) =>
  infiniteQueryOptions({
    queryKey: [...qk.resources, 'list', f, limit],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/api/v1/resources', {
          params: {
            query: {
              limit,
              ...(pageParam ? { cursor: pageParam } : {}),
              ...(f.q ? { q: f.q } : {}),
              ...(f.category ? { 'filter[category]': f.category } : {}),
              ...(f.tag ? { 'filter[tag]': f.tag } : {}),
              ...(f.status ? { 'filter[status]': f.status } : {}),
              ...(f.featured !== undefined
                ? { 'filter[featured]': f.featured ? 'true' : 'false' }
                : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const resourceQuery = (idOrSlug: string) =>
  queryOptions({
    queryKey: [...qk.resources, 'one', idOrSlug],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/resources/{idOrSlug}', { params: { path: { idOrSlug } } })),
  });

export const categoriesQuery = () =>
  queryOptions({
    queryKey: qk.categories,
    queryFn: async () => unwrap(await api.GET('/api/v1/categories')).data,
  });

export const tagsQuery = () =>
  queryOptions({
    queryKey: qk.tags,
    queryFn: async () => unwrap(await api.GET('/api/v1/tags')).data,
  });

export const meQuery = () =>
  queryOptions({
    queryKey: qk.me,
    queryFn: async () => unwrap(await api.GET('/api/v1/me')),
  });
