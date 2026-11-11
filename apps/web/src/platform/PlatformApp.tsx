import { useState, type SyntheticEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlatformTenant } from '@resourcehub/contracts';
import {
  Building2,
  ExternalLink,
  LogIn,
  LogOut,
  Plus,
  ScrollText,
  ShieldAlert,
  UserRoundSearch,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  Input,
  Label,
  PageSpinner,
  Select,
  Spinner,
  Textarea,
} from '@/components/ui';
import { api, errorMessage, idempotent, unwrap } from '@/lib/api';
import { AuthProvider, useAuth } from '@/lib/auth';
import { cn, formatDate, timeAgo, workspaceUrl } from '@/lib/utils';

/**
 * Platform super-admin console. Served on the admin host only; the API refuses platform
 * routes anywhere else and refuses tenant tokens here. Every call is written to the audit log.
 */
export function PlatformApp() {
  document.title = 'ResourceHub · Platform';
  return (
    <AuthProvider>
      <Console />
    </AuthProvider>
  );
}

const onError = (err: unknown) => toast.error(errorMessage(err));

function Console() {
  const { state, user, signIn, signOut } = useAuth();
  const [tab, setTab] = useState<'tenants' | 'audit'>('tenants');
  const params = new URLSearchParams(window.location.search);

  if (state.status === 'loading') return <PageSpinner />;
  if (state.status === 'anonymous') {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-950 px-4">
        <Card className="w-full max-w-sm p-8 text-center">
          <ShieldAlert className="mx-auto mb-4 size-10 text-slate-700" />
          <h1 className="text-xl font-semibold">ResourceHub platform console</h1>
          <p className="mt-1 text-sm text-slate-500">
            Restricted to platform administrators. All actions are audited.
          </p>
          {params.get('error') && (
            <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              That account is not a platform administrator.
            </p>
          )}
          <Button
            size="lg"
            className="mt-6 w-full !bg-slate-900 !text-white"
            onClick={() => signIn('/')}
          >
            <LogIn /> Sign in
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-slate-950 text-slate-100">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-6">
          <span className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="size-5 text-amber-400" /> Platform console
          </span>
          <nav className="flex gap-1 text-sm">
            {(['tenants', 'audit'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'rounded-md px-3 py-1.5 capitalize hover:bg-white/10',
                  tab === t && 'bg-white/15',
                )}
              >
                {t === 'audit' ? 'Platform audit' : 'Tenants'}
              </button>
            ))}
          </nav>
          <span className="ml-auto text-sm text-slate-400">{user?.name}</span>
          <button
            onClick={() => void signOut()}
            className="text-slate-400 hover:text-white"
            aria-label="Sign out"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">
        {tab === 'tenants' ? <Tenants /> : <PlatformAudit />}
      </main>
    </div>
  );
}

function Tenants() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<PlatformTenant | null>(null);
  const list = useQuery({
    queryKey: ['platform', 'tenants'],
    queryFn: async () => unwrap(await api.GET('/api/v1/platform/tenants')).data,
  });
  const update = useMutation({
    mutationFn: async (v: { id: string; status: 'active' | 'suspended' }) =>
      unwrap(
        await api.PATCH('/api/v1/platform/tenants/{id}', {
          params: { path: { id: v.id } },
          body: { status: v.status },
        }),
      ),
    onSuccess: async (t) => {
      await qc.invalidateQueries({ queryKey: ['platform'] });
      toast.success(`${t.name} is now ${t.status}`);
    },
    onError,
  });

  return (
    <>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tenants</h1>
          <p className="text-sm text-slate-500">
            Every workspace on this deployment, across all tenants (BYPASSRLS, audited).
          </p>
        </div>
        <Button className="!bg-slate-900 !text-white" onClick={() => setCreating(true)}>
          <Plus /> New tenant
        </Button>
      </div>
      {list.isPending ? (
        <Spinner />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-5 py-2.5 font-medium">Tenant</th>
                <th className="px-5 py-2.5 font-medium">Plan</th>
                <th className="px-5 py-2.5 font-medium">Members</th>
                <th className="px-5 py-2.5 font-medium">Resources</th>
                <th className="px-5 py-2.5 font-medium">Status</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data?.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50/60">
                  <td className="px-5 py-3">
                    <p className="font-medium">{t.name}</p>
                    <a
                      href={workspaceUrl(t.slug)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-slate-500 hover:underline"
                    >
                      {t.slug}.localhost <ExternalLink className="size-3" />
                    </a>
                    {t.domains.map((d) => (
                      <span key={d.hostname} className="ml-2 text-xs text-slate-400">
                        {d.hostname}
                        {d.verified ? '' : ' (pending)'}
                      </span>
                    ))}
                  </td>
                  <td className="px-5 py-3 capitalize">{t.plan}</td>
                  <td className="px-5 py-3">{t.memberCount}</td>
                  <td className="px-5 py-3">{t.resourceCount}</td>
                  <td className="px-5 py-3">
                    <Badge tone={t.status === 'active' ? 'green' : 'red'}>{t.status}</Badge>
                  </td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setSelected(t)}
                      disabled={t.status !== 'active'}
                    >
                      <UserRoundSearch /> Impersonate
                    </Button>{' '}
                    <Button
                      size="sm"
                      variant={t.status === 'active' ? 'ghost' : 'secondary'}
                      className={t.status === 'active' ? 'text-red-600 hover:bg-red-50' : ''}
                      onClick={() => {
                        const next = t.status === 'active' ? 'suspended' : 'active';
                        if (
                          next === 'active' ||
                          window.confirm(`Suspend ${t.name}? All of its sessions end immediately.`)
                        )
                          update.mutate({ id: t.id, status: next });
                      }}
                    >
                      {t.status === 'active' ? 'Suspend' : 'Reactivate'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {creating && <CreateTenantDialog onClose={() => setCreating(false)} />}
      {selected && <ImpersonateDialog tenant={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <Card className="w-full max-w-lg p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-700"
          >
            <X className="size-5" />
          </button>
        </div>
        {children}
      </Card>
    </div>
  );
}

function CreateTenantDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: '',
    slug: '',
    plan: 'pro' as 'free' | 'pro' | 'enterprise',
    ownerEmail: '',
  });
  const [result, setResult] = useState<{ url: string; ownerInviteUrl: string } | null>(null);
  const create = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST('/api/v1/platform/tenants', { params: idempotent(), body: form })),
    onSuccess: async (r) => {
      setResult(r);
      await qc.invalidateQueries({ queryKey: ['platform'] });
    },
    onError,
  });
  if (result) {
    return (
      <Dialog title="Tenant created" onClose={onClose}>
        <p className="text-sm text-slate-600">
          The workspace is live. Send the owner their one-time invitation link:
        </p>
        <code className="mt-3 block rounded-lg bg-slate-100 p-3 text-xs break-all">
          {result.ownerInviteUrl}
        </code>
        <div className="mt-5 flex justify-end gap-2">
          <a
            href={result.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center px-3 text-sm text-slate-600 hover:underline"
          >
            Open workspace
          </a>
          <Button onClick={() => void navigator.clipboard.writeText(result.ownerInviteUrl)}>
            Copy invite link
          </Button>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog title="New tenant" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e: SyntheticEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div>
          <Label htmlFor="t-name">Name</Label>
          <Input
            id="t-name"
            required
            value={form.name}
            onChange={(e) => {
              const name = e.target.value;
              setForm((f) => ({
                ...f,
                name,
                slug:
                  f.slug ||
                  name
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, ''),
              }));
            }}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="t-slug" hint=".localhost">
              Subdomain
            </Label>
            <Input
              id="t-slug"
              required
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="t-plan">Plan</Label>
            <Select
              id="t-plan"
              value={form.plan}
              onChange={(e) => setForm({ ...form, plan: e.target.value as typeof form.plan })}
            >
              <option>free</option>
              <option>pro</option>
              <option>enterprise</option>
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor="t-owner">Owner email</Label>
          <Input
            id="t-owner"
            type="email"
            required
            value={form.ownerEmail}
            onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })}
          />
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={create.isPending} className="!bg-slate-900 !text-white">
            Create tenant
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ImpersonateDialog({ tenant, onClose }: { tenant: PlatformTenant; onClose: () => void }) {
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const members = useQuery({
    queryKey: ['platform', 'members', tenant.id],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/platform/tenants/{id}/members', {
          params: { path: { id: tenant.id } },
        }),
      ).data,
  });
  const start = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST('/api/v1/platform/impersonations', {
          params: idempotent(),
          body: { tenantId: tenant.id, userId, reason },
        }),
      ),
    onSuccess: (ticket) => {
      // One-time, 60-second hand-off to the tenant host (new tab, so the console stays signed in).
      window.open(ticket.url, '_blank', 'noopener');
      onClose();
    },
    onError,
  });
  return (
    <Dialog title={`Impersonate a member of ${tenant.name}`} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e: SyntheticEvent) => {
          e.preventDefault();
          start.mutate();
        }}
      >
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          You’ll act as this person in a new tab. Both the platform and the tenant’s own audit log
          record your name and your reason on every action.
        </p>
        <div>
          <Label htmlFor="imp-user">Member</Label>
          {members.isPending ? (
            <Spinner />
          ) : (
            <Select
              id="imp-user"
              required
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            >
              <option value="">Choose…</option>
              {members.data?.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name} · {m.role} · {m.email}
                </option>
              ))}
            </Select>
          )}
        </div>
        <div>
          <Label htmlFor="imp-reason" hint="required, recorded">
            Reason
          </Label>
          <Textarea
            id="imp-reason"
            required
            minLength={10}
            rows={2}
            placeholder="Support ticket #… — user can't see attachments"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={start.isPending} className="!bg-amber-500 !text-amber-950">
            <UserRoundSearch /> Start impersonation
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PlatformAudit() {
  const q = useInfiniteQuery({
    queryKey: ['platform', 'audit'],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/api/v1/platform/audit', {
          params: { query: { limit: 40, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Platform audit</h1>
      <p className="mb-6 text-sm text-slate-500">
        Every cross-tenant action, including viewing this page.
      </p>
      <Card>
        <ul className="divide-y divide-slate-100">
          {rows.map((e) => (
            <li
              key={e.id}
              className="grid gap-1 px-5 py-3 text-sm sm:grid-cols-[16rem_9rem_1fr_auto] sm:gap-4"
            >
              <code className="flex items-center gap-1.5 text-xs font-medium text-slate-800">
                <ScrollText className="size-3.5 text-slate-400" /> {e.action}
              </code>
              <span className="flex items-center gap-1 text-xs text-slate-500">
                {e.tenant ? (
                  <>
                    <Building2 className="size-3.5" /> {e.tenant.slug}
                  </>
                ) : (
                  'platform'
                )}
              </span>
              <span className="truncate font-mono text-xs text-slate-500">
                {e.diff ? JSON.stringify(e.diff) : ''}
              </span>
              <span
                className="text-xs whitespace-nowrap text-slate-400"
                title={formatDate(e.createdAt)}
              >
                {e.actor?.name ?? 'system'} · {timeAgo(e.createdAt)}
              </span>
            </li>
          ))}
        </ul>
        {q.hasNextPage && (
          <div className="border-t p-3 text-center">
            <Button size="sm" variant="ghost" onClick={() => void q.fetchNextPage()}>
              Load more
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
