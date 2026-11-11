import { useState, type SyntheticEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Integration } from '@resourcehub/contracts';
import { Activity, CirclePlay, PlugZap, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge, Button, Card, EmptyState, Input, Label, Select, Spinner } from '@/components/ui';
import { api, errorMessage, idempotent, unwrap } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/utils';

const RUN_TONE = { queued: 'amber', running: 'blue', succeeded: 'green', failed: 'red' } as const;
const onError = (err: unknown) => toast.error(errorMessage(err));

function Runs({ integration }: { integration: Integration }) {
  const runs = useQuery({
    queryKey: ['integrations', integration.id, 'runs'],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/integrations/{id}/runs', {
          params: { path: { id: integration.id } },
        }),
      ).data,
    // Poll while anything is in flight so the demo shows queued -> running -> succeeded live.
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.status === 'queued' || r.status === 'running') ? 1500 : false,
  });
  if (runs.isPending) return <Spinner />;
  if (!runs.data?.length) return <p className="text-sm text-slate-400">No runs yet.</p>;
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {runs.data.slice(0, 6).map((r) => (
        <li key={r.id} className="grid grid-cols-[6rem_6rem_1fr_auto] items-center gap-3 py-2">
          <Badge tone={RUN_TONE[r.status]}>{r.status}</Badge>
          <span className="text-xs text-slate-500">
            {r.type} · {r.trigger}
          </span>
          <span className="truncate text-xs text-slate-600">
            {r.error ??
              (r.stats?.pushedReference
                ? `Partner reference ${r.stats.pushedReference}`
                : r.stats
                  ? `${r.stats.fetched ?? 0} fetched · ${r.stats.created ?? 0} new · ${r.stats.updated ?? 0} updated · ${r.stats.unchanged ?? 0} unchanged`
                  : r.attempts > 1
                    ? `attempt ${r.attempts}`
                    : '')}
          </span>
          <span className="text-xs whitespace-nowrap text-slate-400" title={r.createdAt}>
            {timeAgo(r.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function IntegrationCard({ integration }: { integration: Integration }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['integrations'] });
  const test = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST('/api/v1/integrations/{id}/test', {
          params: { path: { id: integration.id } },
        }),
      ),
    onSuccess: (r) =>
      r.ok
        ? toast.success(`Connected in ${r.latencyMs} ms`)
        : toast.error(`${r.code}: ${r.message}`),
    onError,
  });
  const sync = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST('/api/v1/integrations/{id}/sync', {
          params: { path: { id: integration.id }, ...idempotent() },
        }),
      ),
    onSuccess: async () => {
      toast.success('Sync queued; the worker picks it up in a moment');
      await qc.invalidateQueries({ queryKey: ['integrations', integration.id, 'runs'] });
    },
    onError,
  });
  const update = useMutation({
    mutationFn: async (body: { enabled?: boolean; scheduleMinutes?: number | null }) =>
      unwrap(
        await api.PATCH('/api/v1/integrations/{id}', {
          params: { path: { id: integration.id } },
          body,
        }),
      ),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.DELETE('/api/v1/integrations/{id}', { params: { path: { id: integration.id } } }),
      ),
    onSuccess: refresh,
    onError,
  });

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-10 place-items-center rounded-lg bg-brand/10 text-brand">
          <PlugZap className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{integration.name}</p>
          <p className="text-xs text-slate-500">
            <Badge
              tone={integration.kind === 'soap' ? 'blue' : 'green'}
              className="mr-1.5 uppercase"
            >
              {integration.kind}
            </Badge>
            {integration.provider}
            {integration.secretRef && (
              <>
                {' '}
                · secret <code className="rounded bg-slate-100 px-1">{integration.secretRef}</code>
              </>
            )}
            {integration.lastSyncedAt && (
              <> · synced up to {formatDate(integration.lastSyncedAt)}</>
            )}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={integration.enabled}
            onChange={(e) => update.mutate({ enabled: e.target.checked })}
            className="size-4 accent-[var(--brand-primary)]"
          />
          Enabled
        </label>
        <Select
          aria-label="Schedule"
          className="w-36"
          value={integration.scheduleMinutes ?? ''}
          onChange={(e) =>
            update.mutate({ scheduleMinutes: e.target.value ? Number(e.target.value) : null })
          }
        >
          <option value="">Manual only</option>
          <option value="15">Every 15 min</option>
          <option value="60">Hourly</option>
          <option value="1440">Daily</option>
        </Select>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={test.isPending}
          onClick={() => test.mutate()}
        >
          <Activity /> Test connection
        </Button>
        <Button
          size="sm"
          loading={sync.isPending}
          disabled={!integration.enabled}
          onClick={() => sync.mutate()}
        >
          <CirclePlay /> Sync now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void qc.invalidateQueries({ queryKey: ['integrations', integration.id, 'runs'] })
          }
          aria-label="Refresh runs"
        >
          <RefreshCw />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-red-600 hover:bg-red-50"
          onClick={() =>
            window.confirm(`Delete “${integration.name}”? Imported resources stay.`) &&
            remove.mutate()
          }
        >
          <Trash2 /> Delete
        </Button>
      </div>
      <div className="mt-4 border-t border-slate-100 pt-3">
        <Runs integration={integration} />
      </div>
    </Card>
  );
}

function AddIntegration({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const providers = useQuery({
    queryKey: ['integrations', 'providers'],
    queryFn: async () => unwrap(await api.GET('/api/v1/integrations/providers')).data,
  });
  const [provider, setProvider] = useState('');
  const [name, setName] = useState('');
  const [secretRef, setSecretRef] = useState('');
  const [configText, setConfigText] = useState('{}');
  const def = providers.data?.find((p) => p.provider === provider);
  const create = useMutation({
    mutationFn: async () => {
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(configText) as Record<string, unknown>;
      } catch {
        throw new Error('Config must be valid JSON');
      }
      return unwrap(
        await api.POST('/api/v1/integrations', {
          params: idempotent(),
          body: { provider, name, config, ...(secretRef ? { secretRef } : {}) },
        }),
      );
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['integrations'] });
      toast.success('Integration added');
      onClose();
    },
    onError,
  });
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium">Add an integration</h3>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-slate-400 hover:text-slate-700"
        >
          <X className="size-4" />
        </button>
      </div>
      <form
        className="space-y-4"
        onSubmit={(e: SyntheticEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="int-provider">Provider</Label>
            <Select
              id="int-provider"
              required
              value={provider}
              onChange={(e) => {
                const p = providers.data?.find((x) => x.provider === e.target.value);
                setProvider(e.target.value);
                setName(p?.label.replace(/ \(.*\)$/, '') ?? '');
                setConfigText(JSON.stringify(p?.defaults ?? {}, null, 2));
              }}
            >
              <option value="">Choose…</option>
              {providers.data?.map((p) => (
                <option key={p.provider} value={p.provider}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="int-name">Name</Label>
            <Input id="int-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        {def && <p className="text-xs text-slate-500">{def.description}</p>}
        <div>
          <Label htmlFor="int-config" hint="non-secret settings">
            Config (JSON)
          </Label>
          <textarea
            id="int-config"
            rows={5}
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            className="w-full rounded-lg border border-slate-200 p-2 font-mono text-xs"
          />
        </div>
        {def?.needsSecret && (
          <div>
            <Label htmlFor="int-secret" hint="a reference, never the secret">
              Secret reference
            </Label>
            <Input
              id="int-secret"
              required
              placeholder="env:PARTNER_SOAP_PASSWORD or kv:partner-soap-password"
              value={secretRef}
              onChange={(e) => setSecretRef(e.target.value)}
            />
          </div>
        )}
        <div className="flex justify-end">
          <Button type="submit" loading={create.isPending}>
            Add integration
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function IntegrationsPage() {
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: ['integrations'],
    queryFn: async () => unwrap(await api.GET('/api/v1/integrations')).data,
  });
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <p className="max-w-xl text-sm text-slate-500">
          Pull content from partner systems over REST or SOAP. Syncs run in the background worker
          with retries, a circuit breaker and a run history; imported items arrive as drafts.
        </p>
        {!adding && (
          <Button onClick={() => setAdding(true)}>
            <Plus /> Add
          </Button>
        )}
      </div>
      {adding && <AddIntegration onClose={() => setAdding(false)} />}
      {list.isPending ? (
        <Spinner />
      ) : list.data?.length === 0 ? (
        <EmptyState icon={<PlugZap />} title="No integrations yet" />
      ) : (
        list.data?.map((i) => <IntegrationCard key={i.id} integration={i} />)
      )}
    </div>
  );
}
