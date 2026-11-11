import { useState, type SyntheticEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowRight, Search, Sparkles } from 'lucide-react';
import { CategoryIcon } from '@/components/icons';
import { ResourceCard } from '@/components/ResourceCard';
import { Card, Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useBranding } from '@/lib/branding';
import { categoriesQuery, resourcesQuery } from '@/lib/queries';
import { timeAgo } from '@/lib/utils';

export function HomePage() {
  const b = useBranding();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const cats = useQuery(categoriesQuery());
  const featured = useInfiniteQuery(resourcesQuery({ featured: true }, 3));
  const recent = useInfiniteQuery(resourcesQuery({}, 6));

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    void navigate({ to: '/resources', search: q ? { q } : {} });
  };

  return (
    <div className="space-y-12">
      <section className="relative overflow-hidden rounded-2xl bg-brand px-6 py-12 text-brand-foreground shadow-sm sm:px-10 sm:py-14">
        <div
          className="pointer-events-none absolute inset-0 opacity-30"
          style={{
            background:
              'radial-gradient(60rem 30rem at 110% -20%, var(--brand-accent), transparent 60%), radial-gradient(40rem 20rem at -10% 120%, rgba(255,255,255,.35), transparent 60%)',
          }}
        />
        <div className="relative max-w-2xl">
          <p className="text-sm font-medium opacity-80">
            Welcome back{user ? `, ${user.name.split(' ')[0]}` : ''}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{b.hubTitle}</h1>
          {b.tagline && <p className="mt-3 text-base opacity-90">{b.tagline}</p>}
          <form onSubmit={submit} className="relative mt-7">
            <Search className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search SOPs, guides, checklists…"
              aria-label="Search"
              className="h-12 w-full rounded-xl border-0 bg-white pr-28 pl-12 text-slate-900 shadow-lg placeholder:text-slate-400 focus:ring-4 focus:ring-white/40 focus:outline-none"
            />
            <button
              type="submit"
              className="absolute top-1.5 right-1.5 h-9 rounded-lg bg-brand px-4 text-sm font-medium text-brand-foreground hover:brightness-110"
            >
              Search
            </button>
          </form>
        </div>
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Browse by category</h2>
          <Link
            to="/resources"
            className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
          >
            All resources <ArrowRight className="size-4" />
          </Link>
        </div>
        {cats.isPending ? (
          <Spinner />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {(cats.data ?? []).map((c) => (
              <Link key={c.id} to="/resources" search={{ category: c.slug }} className="group">
                <Card className="h-full p-4 transition hover:border-brand/40 hover:shadow-md">
                  <div className="mb-3 grid size-10 place-items-center rounded-lg bg-brand/10 text-brand transition group-hover:bg-brand group-hover:text-brand-foreground">
                    <CategoryIcon name={c.icon} className="size-5" />
                  </div>
                  <p className="font-medium text-slate-900">{c.name}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{c.description}</p>
                  <p className="mt-3 text-xs font-medium text-slate-400">
                    {c.resourceCount} resource{c.resourceCount === 1 ? '' : 's'}
                  </p>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-8 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Sparkles className="size-5 text-brand-accent" /> Featured
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {featured.data?.pages[0]?.data.map((r) => (
              <ResourceCard key={r.id} r={r} />
            ))}
          </div>
        </section>
        <section>
          <h2 className="mb-4 text-lg font-semibold tracking-tight">Recently updated</h2>
          <Card className="divide-y divide-slate-100">
            {recent.data?.pages[0]?.data.map((r) => (
              <Link
                key={r.id}
                to="/resources/$slug"
                params={{ slug: r.slug }}
                className="block px-4 py-3 hover:bg-slate-50"
              >
                <p className="text-sm font-medium text-slate-900">{r.title}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {r.category?.name ?? 'Uncategorized'} · {timeAgo(r.updatedAt)}
                </p>
              </Link>
            ))}
          </Card>
        </section>
      </div>
    </div>
  );
}
