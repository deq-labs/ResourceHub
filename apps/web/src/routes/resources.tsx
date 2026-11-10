import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { FileSearch, Plus, Search, X } from 'lucide-react';
import { ResourceCard } from '@/components/ResourceCard';
import { CategoryIcon } from '@/components/icons';
import {
  Button,
  buttonVariants,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { categoriesQuery, resourcesQuery, tagsQuery } from '@/lib/queries';
import { cn } from '@/lib/utils';

export interface ResourceSearch {
  q?: string;
  category?: string;
  tag?: string;
  status?: 'draft' | 'published' | 'archived';
}

export function ResourcesPage({ search }: { search: ResourceSearch }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState(search.q ?? '');
  useEffect(() => setQ(search.q ?? ''), [search.q]);

  const cats = useQuery(categoriesQuery());
  const tags = useQuery(tagsQuery());
  const list = useInfiniteQuery(resourcesQuery(search));
  const items = list.data?.pages.flatMap((p) => p.data) ?? [];

  const set = (patch: Partial<ResourceSearch>) =>
    void navigate({ to: '/resources', search: (prev: ResourceSearch) => ({ ...prev, ...patch }) });

  const activeCategory = cats.data?.find((c) => c.slug === search.category);

  return (
    <div className="grid gap-8 lg:grid-cols-[15rem_1fr]">
      <aside className="space-y-6 lg:sticky lg:top-24 lg:self-start">
        <div>
          <h3 className="mb-2 px-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
            Categories
          </h3>
          <nav className="space-y-0.5">
            <button
              onClick={() => set({ category: undefined })}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-900/5',
                !search.category && 'bg-brand/10 font-medium text-brand',
              )}
            >
              All categories
            </button>
            {cats.data?.map((c) => (
              <button
                key={c.id}
                onClick={() => set({ category: c.slug })}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-900/5',
                  search.category === c.slug && 'bg-brand/10 font-medium text-brand',
                )}
              >
                <CategoryIcon name={c.icon} className="size-4 shrink-0" />
                <span className="flex-1 truncate">{c.name}</span>
                <span className="text-xs text-slate-400">{c.resourceCount}</span>
              </button>
            ))}
          </nav>
        </div>
        <div>
          <h3 className="mb-2 px-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
            Tags
          </h3>
          <div className="flex flex-wrap gap-1.5 px-1">
            {tags.data
              ?.filter((t) => t.resourceCount > 0)
              .map((t) => (
                <button
                  key={t.id}
                  onClick={() => set({ tag: search.tag === t.slug ? undefined : t.slug })}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-xs transition',
                    search.tag === t.slug
                      ? 'border-brand bg-brand text-brand-foreground'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-brand/50',
                  )}
                >
                  #{t.name}
                </button>
              ))}
          </div>
        </div>
      </aside>

      <section>
        <PageHeader
          title={activeCategory?.name ?? 'All resources'}
          description={
            activeCategory?.description ?? 'Everything your team has published in this workspace.'
          }
          actions={
            can('editor') && (
              <Link to="/resources/new" className={buttonVariants()}>
                <Plus /> New resource
              </Link>
            )
          }
        />
        <form
          className="mb-5 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: q || undefined });
          }}
        >
          <div className="relative min-w-60 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search titles, summaries and content"
              className="pl-9"
            />
          </div>
          {can('editor') && (
            <Select
              value={search.status ?? ''}
              onChange={(e) =>
                set({ status: (e.target.value || undefined) as ResourceSearch['status'] })
              }
              className="w-40"
              aria-label="Status"
            >
              <option value="">Active (all)</option>
              <option value="published">Published</option>
              <option value="draft">Drafts</option>
              <option value="archived">Archived</option>
            </Select>
          )}
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        {(search.q || search.tag) && (
          <div className="mb-4 flex flex-wrap gap-2 text-sm">
            {search.q && (
              <button
                onClick={() => set({ q: undefined })}
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 hover:bg-slate-200"
              >
                “{search.q}” <X className="size-3.5" />
              </button>
            )}
            {search.tag && (
              <button
                onClick={() => set({ tag: undefined })}
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 hover:bg-slate-200"
              >
                #{search.tag} <X className="size-3.5" />
              </button>
            )}
          </div>
        )}

        {list.isPending ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState icon={<FileSearch />} title="No resources match">
            Try a different search or clear the filters.
          </EmptyState>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((r) => (
                <ResourceCard key={r.id} r={r} showStatus={can('editor')} />
              ))}
            </div>
            {list.hasNextPage && (
              <div className="mt-6 text-center">
                <Button
                  variant="secondary"
                  loading={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
