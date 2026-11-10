import { Link } from '@tanstack/react-router';
import type { ResourceSummary } from '@resourcehub/contracts';
import { PlugZap, Star } from 'lucide-react';
import { Badge, Card, STATUS_TONE } from './ui';
import { timeAgo } from '@/lib/utils';

export function ResourceCard({
  r,
  showStatus = false,
}: {
  r: ResourceSummary;
  showStatus?: boolean;
}) {
  return (
    <Link
      to="/resources/$slug"
      params={{ slug: r.slug }}
      className="group block focus-visible:rounded-xl"
    >
      <Card className="flex h-full flex-col p-5 transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md">
        <div className="mb-3 flex items-center gap-2 text-xs text-slate-500">
          {r.category && (
            <span className="inline-flex items-center gap-1.5 font-medium text-brand">
              {r.category.name}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            {r.featured && (
              <Star
                className="size-3.5 fill-brand-accent text-brand-accent"
                aria-label="Featured"
              />
            )}
            {r.source && (
              <PlugZap
                className="size-3.5 text-sky-600"
                aria-label={`Synced from ${r.source.system}`}
              />
            )}
            {showStatus && r.status !== 'published' && (
              <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
            )}
          </span>
        </div>
        <h3 className="font-semibold leading-snug text-slate-900 group-hover:text-brand">
          {r.title}
        </h3>
        {r.summary && <p className="mt-1.5 line-clamp-2 text-sm text-slate-600">{r.summary}</p>}
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-4">
          {r.tags.slice(0, 3).map((t) => (
            <Badge key={t.id}>#{t.name}</Badge>
          ))}
          <span className="ml-auto text-xs text-slate-400">{timeAgo(r.updatedAt)}</span>
        </div>
      </Card>
    </Link>
  );
}
