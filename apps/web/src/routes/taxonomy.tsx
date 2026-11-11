import { useState, type SyntheticEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { CATEGORY_ICON_NAMES, CategoryIcon } from '@/components/icons';
import { Badge, Button, Card, Input, Label, PageHeader, Select, Spinner } from '@/components/ui';
import { api, errorMessage, idempotent, unwrap } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { categoriesQuery, qk, tagsQuery } from '@/lib/queries';

export function TaxonomyPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const cats = useQuery(categoriesQuery());
  const tags = useQuery(tagsQuery());
  const [cat, setCat] = useState({ name: '', description: '', icon: 'clipboard-list' });
  const [tag, setTag] = useState('');

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.categories }),
      qc.invalidateQueries({ queryKey: qk.tags }),
    ]);
  const onError = (err: unknown) => toast.error(errorMessage(err));

  const addCat = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST('/api/v1/categories', {
          params: idempotent(),
          body: { name: cat.name, description: cat.description || undefined, icon: cat.icon },
        }),
      ),
    onSuccess: async () => {
      setCat({ name: '', description: '', icon: 'clipboard-list' });
      await refresh();
      toast.success('Category added');
    },
    onError,
  });
  const delCat = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/v1/categories/{id}', { params: { path: { id } } })),
    onSuccess: refresh,
    onError,
  });
  const addTag = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST('/api/v1/tags', { params: idempotent(), body: { name: tag } })),
    onSuccess: async () => {
      setTag('');
      await refresh();
    },
    onError,
  });
  const delTag = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/v1/tags/{id}', { params: { path: { id } } })),
    onSuccess: refresh,
    onError,
  });

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Taxonomy"
        description="Categories group resources on the home page; tags make them easy to filter."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <div className="border-b border-slate-100 px-5 py-3 text-sm font-medium">Categories</div>
          {cats.isPending ? (
            <div className="p-5">
              <Spinner />
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {cats.data?.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-5 py-3">
                  <span className="grid size-9 place-items-center rounded-lg bg-brand/10 text-brand">
                    <CategoryIcon name={c.icon} className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{c.name}</p>
                    <p className="truncate text-xs text-slate-500">{c.description}</p>
                  </div>
                  <Badge>{c.resourceCount}</Badge>
                  {can('admin') && (
                    <button
                      onClick={() =>
                        window.confirm(
                          `Delete category “${c.name}”? Resources stay, uncategorized.`,
                        ) && delCat.mutate(c.id)
                      }
                      className="text-slate-400 hover:text-red-600"
                      aria-label={`Delete ${c.name}`}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <form
            className="grid gap-3 border-t border-slate-100 bg-slate-50/60 p-5 sm:grid-cols-[1fr_1fr_10rem_auto]"
            onSubmit={(e: SyntheticEvent) => {
              e.preventDefault();
              addCat.mutate();
            }}
          >
            <div>
              <Label htmlFor="cat-name">Name</Label>
              <Input
                id="cat-name"
                required
                value={cat.name}
                onChange={(e) => setCat({ ...cat, name: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="cat-desc">Description</Label>
              <Input
                id="cat-desc"
                value={cat.description}
                onChange={(e) => setCat({ ...cat, description: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="cat-icon">Icon</Label>
              <Select
                id="cat-icon"
                value={cat.icon}
                onChange={(e) => setCat({ ...cat, icon: e.target.value })}
              >
                {CATEGORY_ICON_NAMES.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </Select>
            </div>
            <Button type="submit" className="self-end" loading={addCat.isPending}>
              <Plus /> Add
            </Button>
          </form>
        </Card>

        <Card className="self-start">
          <div className="border-b border-slate-100 px-5 py-3 text-sm font-medium">Tags</div>
          <div className="flex flex-wrap gap-1.5 p-5">
            {tags.data?.map((t) => (
              <span
                key={t.id}
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pr-1 pl-2.5 text-xs"
              >
                #{t.name} <span className="text-slate-400">{t.resourceCount}</span>
                {can('admin') && (
                  <button
                    onClick={() => delTag.mutate(t.id)}
                    className="rounded-full p-0.5 text-slate-400 hover:bg-white hover:text-red-600"
                    aria-label={`Delete ${t.name}`}
                  >
                    <Trash2 className="size-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
          <form
            className="flex gap-2 border-t border-slate-100 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              addTag.mutate();
            }}
          >
            <Input
              required
              placeholder="new tag"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
            />
            <Button type="submit" variant="secondary" loading={addTag.isPending}>
              Add
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
