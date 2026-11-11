import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Download, ExternalLink, FileText, Pencil, PlugZap } from 'lucide-react';
import { toast } from 'sonner';
import { Badge, buttonVariants, Card, EmptyState, PageSpinner, STATUS_TONE } from '@/components/ui';
import { api, ApiError, errorMessage, unwrap } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { SendToPartner } from '@/components/SendToPartner';
import { renderMarkdown } from '@/lib/markdown';
import { resourceQuery } from '@/lib/queries';
import { formatBytes, formatDate } from '@/lib/utils';

async function download(fileId: string) {
  try {
    const { url } = unwrap(
      await api.GET('/api/v1/files/{id}/download', { params: { path: { id: fileId } } }),
    );
    window.location.assign(url);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

export function ResourceDetailPage({ slug }: { slug: string }) {
  const { can } = useAuth();
  const q = useQuery(resourceQuery(slug));
  const html = useMemo(() => (q.data ? renderMarkdown(q.data.body.content) : ''), [q.data]);

  if (q.isPending) return <PageSpinner />;
  if (q.error) {
    const notFound = q.error instanceof ApiError && q.error.problem.status === 404;
    return (
      <EmptyState
        icon={<FileText />}
        title={notFound ? 'Resource not found' : 'Could not load this resource'}
      >
        {notFound
          ? 'It may have been unpublished or never existed in this workspace.'
          : errorMessage(q.error)}
      </EmptyState>
    );
  }
  const r = q.data;

  return (
    <div className="mx-auto max-w-4xl">
      <nav className="mb-4 flex items-center gap-1 text-sm text-slate-500">
        <Link to="/resources" className="hover:text-slate-900">
          Resources
        </Link>
        {r.category && (
          <>
            <ChevronRight className="size-4" />
            <Link
              to="/resources"
              search={{ category: r.category.slug }}
              className="hover:text-slate-900"
            >
              {r.category.name}
            </Link>
          </>
        )}
      </nav>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {r.status !== 'published' && <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>}
            {r.featured && <Badge tone="accent">Featured</Badge>}
            {r.source && (
              <Badge tone="blue">
                <PlugZap className="size-3" /> Synced from {r.source.system}
              </Badge>
            )}
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{r.title}</h1>
          {r.summary && <p className="mt-2 text-lg text-slate-600">{r.summary}</p>}
          <p className="mt-3 text-sm text-slate-500">
            {r.author ? `By ${r.author.name} · ` : ''}
            {r.publishedAt ? `Published ${formatDate(r.publishedAt)} · ` : ''}Updated{' '}
            {formatDate(r.updatedAt)}
          </p>
        </div>
        {can('editor') && (
          <Link
            to="/resources/$slug/edit"
            params={{ slug: r.slug }}
            className={buttonVariants({ variant: 'secondary' })}
          >
            <Pencil /> Edit
          </Link>
        )}
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_16rem]">
        <Card className="p-6 sm:p-8">
          {r.body.content.trim() ? (
            <article
              className="prose prose-slate max-w-none prose-headings:tracking-tight"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <p className="text-sm text-slate-400 italic">No content yet.</p>
          )}
        </Card>
        <aside className="space-y-6">
          {r.tags.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Tags
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {r.tags.map((t) => (
                  <Link key={t.id} to="/resources" search={{ tag: t.slug }}>
                    <Badge className="hover:bg-slate-200">#{t.name}</Badge>
                  </Link>
                ))}
              </div>
            </div>
          )}
          <div>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
              Attachments
            </h3>
            {r.attachments.length === 0 ? (
              <p className="text-sm text-slate-400">None</p>
            ) : (
              <ul className="space-y-2">
                {r.attachments.map((f) => (
                  <li key={f.id}>
                    <button
                      onClick={() => void download(f.id)}
                      className="flex w-full items-center gap-3 rounded-lg border border-slate-200 bg-white p-2.5 text-left text-sm hover:border-brand/50"
                    >
                      <FileText className="size-5 shrink-0 text-brand" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{f.filename}</span>
                        <span className="text-xs text-slate-400">{formatBytes(f.size)}</span>
                      </span>
                      <Download className="size-4 text-slate-400" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {r.source?.url && (
            <a
              href={r.source.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-sm text-brand hover:underline"
            >
              View in {r.source.system} <ExternalLink className="size-3.5" />
            </a>
          )}
          {can('admin') && r.status === 'published' && <SendToPartner resourceId={r.id} />}
        </aside>
      </div>
    </div>
  );
}
