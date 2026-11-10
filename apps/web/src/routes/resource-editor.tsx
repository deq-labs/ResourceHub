import { useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ALLOWED_UPLOAD_TYPES, MAX_UPLOAD_BYTES, type Resource } from '@resourcehub/contracts';
import { Eye, FileText, Paperclip, Pencil, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  Input,
  Label,
  PageHeader,
  PageSpinner,
  Select,
  STATUS_TONE,
  Textarea,
} from '@/components/ui';
import { api, errorMessage, idempotent, unwrap } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { renderMarkdown } from '@/lib/markdown';
import { categoriesQuery, qk, resourceQuery, tagsQuery } from '@/lib/queries';
import { cn, formatBytes } from '@/lib/utils';

type Status = Resource['status'];

interface FormState {
  title: string;
  summary: string;
  body: string;
  status: Status;
  featured: boolean;
  categoryId: string;
  tagIds: string[];
}

const empty: FormState = {
  title: '',
  summary: '',
  body: '',
  status: 'draft',
  featured: false,
  categoryId: '',
  tagIds: [],
};

function fromResource(r: Resource): FormState {
  return {
    title: r.title,
    summary: r.summary ?? '',
    body: r.body.content,
    status: r.status,
    featured: r.featured,
    categoryId: r.category?.id ?? '',
    tagIds: r.tags.map((t) => t.id),
  };
}

export function ResourceEditorPage({ slug }: { slug?: string }) {
  const existing = useQuery({ ...resourceQuery(slug ?? ''), enabled: !!slug });
  if (slug && existing.isPending) return <PageSpinner />;
  return <Editor key={existing.data?.id ?? 'new'} resource={existing.data} />;
}

function Editor({ resource }: { resource?: Resource }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [form, setForm] = useState<FormState>(resource ? fromResource(resource) : empty);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const cats = useQuery(categoriesQuery());
  const tags = useQuery(tagsQuery());
  const preview = useMemo(
    () => (tab === 'preview' ? renderMarkdown(form.body) : ''),
    [tab, form.body],
  );
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: async (status: Status) => {
      const body = {
        title: form.title,
        summary: form.summary || undefined,
        body: form.body,
        status,
        featured: form.featured,
        categoryId: form.categoryId || null,
        tagIds: form.tagIds,
      };
      return resource
        ? unwrap(
            await api.PATCH('/api/v1/resources/{id}', {
              params: { path: { id: resource.id } },
              body: { ...body, summary: form.summary || null },
            }),
          )
        : unwrap(await api.POST('/api/v1/resources', { params: idempotent(), body }));
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: qk.resources });
      await qc.invalidateQueries({ queryKey: qk.categories });
      toast.success(resource ? 'Saved' : 'Resource created');
      void navigate({
        to: resource ? '/resources/$slug' : '/resources/$slug/edit',
        params: { slug: r.slug },
      });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: async () => {
      unwrap(
        await api.DELETE('/api/v1/resources/{id}', { params: { path: { id: resource!.id } } }),
      );
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.resources });
      toast.success('Deleted');
      void navigate({ to: '/resources' });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    save.mutate(form.status);
  };

  return (
    <form onSubmit={submit} className="mx-auto max-w-5xl">
      <PageHeader
        title={resource ? 'Edit resource' : 'New resource'}
        description={
          resource ? (
            <Badge tone={STATUS_TONE[resource.status]}>{resource.status}</Badge>
          ) : (
            'Drafts are only visible to editors and admins.'
          )
        }
        actions={
          <>
            <Link
              to={resource ? '/resources/$slug' : '/resources'}
              params={resource ? { slug: resource.slug } : {}}
              className="inline-flex h-9 items-center px-3 text-sm text-slate-600 hover:text-slate-900"
            >
              Cancel
            </Link>
            <Button
              type="submit"
              variant="secondary"
              loading={save.isPending && save.variables === form.status}
            >
              Save
            </Button>
            {form.status !== 'published' && (
              <Button
                type="button"
                loading={save.isPending && save.variables === 'published'}
                onClick={() => save.mutate('published')}
              >
                Publish
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-5">
          <Card className="space-y-5 p-6">
            <div>
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                required
                minLength={3}
                maxLength={160}
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="summary" hint={`${form.summary.length}/400`}>
                Summary
              </Label>
              <Textarea
                id="summary"
                rows={2}
                maxLength={400}
                value={form.summary}
                onChange={(e) => set('summary', e.target.value)}
              />
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">Body (Markdown)</span>
                <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs">
                  {(['write', 'preview'] as const).map((t) => (
                    <button
                      type="button"
                      key={t}
                      onClick={() => setTab(t)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md px-2.5 py-1 capitalize',
                        tab === t && 'bg-white font-medium shadow-sm',
                      )}
                    >
                      {t === 'write' ? <Pencil className="size-3" /> : <Eye className="size-3" />}{' '}
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              {tab === 'write' ? (
                <Textarea
                  rows={18}
                  className="font-mono text-[13px]"
                  value={form.body}
                  onChange={(e) => set('body', e.target.value)}
                  placeholder={'## Heading\n\n- bullet\n- **bold**'}
                />
              ) : (
                <div
                  className="prose prose-slate min-h-[26rem] max-w-none rounded-lg border border-slate-200 p-4"
                  dangerouslySetInnerHTML={{
                    __html: preview || '<p class="text-slate-400">Nothing to preview</p>',
                  }}
                />
              )}
            </div>
          </Card>
          {resource ? (
            <Attachments resource={resource} />
          ) : (
            <p className="text-sm text-slate-500">Save the draft to add attachments.</p>
          )}
        </div>

        <div className="space-y-5">
          <Card className="space-y-4 p-5">
            <div>
              <Label htmlFor="status">Status</Label>
              <Select
                id="status"
                value={form.status}
                onChange={(e) => set('status', e.target.value as Status)}
              >
                <option value="draft">Draft</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="category">Category</Label>
              <Select
                id="category"
                value={form.categoryId}
                onChange={(e) => set('categoryId', e.target.value)}
              >
                <option value="">Uncategorized</option>
                {cats.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.featured}
                onChange={(e) => set('featured', e.target.checked)}
                className="size-4 rounded accent-[var(--brand-primary)]"
              />
              Feature on the home page
            </label>
          </Card>
          <Card className="p-5">
            <Label>Tags</Label>
            <div className="flex flex-wrap gap-1.5">
              {tags.data?.map((t) => {
                const on = form.tagIds.includes(t.id);
                return (
                  <button
                    type="button"
                    key={t.id}
                    onClick={() =>
                      set(
                        'tagIds',
                        on ? form.tagIds.filter((x) => x !== t.id) : [...form.tagIds, t.id],
                      )
                    }
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-xs',
                      on
                        ? 'border-brand bg-brand text-brand-foreground'
                        : 'border-slate-200 text-slate-600 hover:border-brand/50',
                    )}
                  >
                    #{t.name}
                  </button>
                );
              })}
            </div>
            <Link
              to="/manage/taxonomy"
              className="mt-3 inline-block text-xs text-brand hover:underline"
            >
              Manage tags
            </Link>
          </Card>
          {resource && can('admin') && (
            <Button
              type="button"
              variant="ghost"
              className="w-full text-red-600 hover:bg-red-50"
              loading={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete “${resource.title}”? This cannot be undone.`))
                  remove.mutate();
              }}
            >
              <Trash2 /> Delete resource
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}

/** Direct-to-blob upload: ask the API for a write-only SAS, PUT the bytes, then confirm. */
function Attachments({ resource }: { resource: Resource }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const upload = async (file: File) => {
    if (!(ALLOWED_UPLOAD_TYPES as readonly string[]).includes(file.type)) {
      toast.error(`${file.type || 'This file type'} is not allowed.`);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error('Files must be 25 MB or smaller.');
      return;
    }
    setBusy(file.name);
    try {
      const ticket = unwrap(
        await api.POST('/api/v1/files/uploads', {
          params: idempotent(),
          body: {
            purpose: 'attachment',
            filename: file.name,
            mime: file.type as (typeof ALLOWED_UPLOAD_TYPES)[number],
            size: file.size,
            resourceId: resource.id,
          },
        }),
      );
      const put = await fetch(ticket.uploadUrl, {
        method: 'PUT',
        headers: ticket.headers,
        body: file,
      });
      if (!put.ok) throw new Error(`Blob upload failed (${put.status})`);
      unwrap(
        await api.POST('/api/v1/files/{id}/complete', { params: { path: { id: ticket.file.id } } }),
      );
      await qc.invalidateQueries({ queryKey: qk.resources });
      toast.success(`${file.name} uploaded`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    try {
      unwrap(await api.DELETE('/api/v1/files/{id}', { params: { path: { id } } }));
      await qc.invalidateQueries({ queryKey: qk.resources });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Card className="p-6">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <Paperclip className="size-4" /> Attachments
        </h3>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={busy !== null}
          onClick={() => input.current?.click()}
        >
          <Upload /> Upload
        </Button>
        <input
          ref={input}
          type="file"
          className="hidden"
          accept={ALLOWED_UPLOAD_TYPES.join(',')}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
      </div>
      {resource.attachments.length === 0 && !busy ? (
        <p className="text-sm text-slate-400">
          PDFs, images, Office documents. Max 25 MB. Files go straight to tenant-scoped blob
          storage.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {resource.attachments.map((f) => (
            <li key={f.id} className="flex items-center gap-3 py-2 text-sm">
              <FileText className="size-4 text-brand" />
              <span className="flex-1 truncate">{f.filename}</span>
              <span className="text-xs text-slate-400">{formatBytes(f.size)}</span>
              <button
                type="button"
                onClick={() => void remove(f.id)}
                className="text-slate-400 hover:text-red-600"
                aria-label={`Remove ${f.filename}`}
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
          {busy && <li className="py-2 text-sm text-slate-500">Uploading {busy}…</li>}
        </ul>
      )}
    </Card>
  );
}
