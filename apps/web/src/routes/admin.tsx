import { useEffect, useState, type SyntheticEvent } from 'react';
import { createRoute, Link, Outlet, type AnyRoute } from '@tanstack/react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BRAND_FONTS, type Branding, type Role } from '@resourcehub/contracts';
import {
  Check,
  Copy,
  Globe,
  ImageUp,
  Mail,
  Palette,
  PlugZap,
  ScrollText,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import { IntegrationsPage } from './integrations';
import { toast } from 'sonner';
import { RequireRole } from '@/components/RequireRole';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui';
import { api, errorMessage, idempotent, unwrap } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { applyBranding, monogramDataUrl, useBranding } from '@/lib/branding';
import { cn, formatDate, timeAgo } from '@/lib/utils';

const ROLES: Role[] = ['viewer', 'editor', 'admin', 'owner'];
const ROLE_TONE = { owner: 'brand', admin: 'blue', editor: 'green', viewer: 'neutral' } as const;
const onError = (err: unknown) => toast.error(errorMessage(err));

function AdminLayout() {
  const tabs = [
    { to: '/admin', label: 'Members', icon: Users, exact: true },
    { to: '/admin/invitations', label: 'Invitations', icon: Mail },
    { to: '/admin/branding', label: 'Branding', icon: Palette },
    { to: '/admin/domains', label: 'Domains', icon: Globe },
    { to: '/admin/integrations', label: 'Integrations', icon: PlugZap },
    { to: '/admin/audit', label: 'Audit log', icon: ScrollText },
  ];
  return (
    <RequireRole min="admin">
      <PageHeader
        title="Workspace admin"
        description="People, roles, look and feel, domains, and the full audit trail."
      />
      <div className="grid gap-8 lg:grid-cols-[13rem_1fr]">
        <nav className="flex gap-1 overflow-x-auto lg:flex-col">
          {tabs.map((t) => (
            <Link
              key={t.to}
              to={t.to}
              activeOptions={{ exact: t.exact ?? false }}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap text-slate-600 hover:bg-slate-900/5"
              activeProps={{ className: 'bg-brand/10 font-medium !text-brand' }}
            >
              <t.icon className="size-4" /> {t.label}
            </Link>
          ))}
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </RequireRole>
  );
}

// ---- members --------------------------------------------------------------------------------

function MembersPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const members = useQuery({
    queryKey: ['members'],
    queryFn: async () => unwrap(await api.GET('/api/v1/members')).data,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['members'] });
  const change = useMutation({
    mutationFn: async (v: { userId: string; role: Role }) =>
      unwrap(
        await api.PATCH('/api/v1/members/{userId}', {
          params: { path: { userId: v.userId } },
          body: { role: v.role },
        }),
      ),
    onSuccess: async () => {
      await refresh();
      toast.success('Role updated');
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: async (userId: string) =>
      unwrap(await api.DELETE('/api/v1/members/{userId}', { params: { path: { userId } } })),
    onSuccess: async () => {
      await refresh();
      toast.success('Member removed and signed out');
    },
    onError,
  });

  return (
    <Card>
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <h2 className="text-sm font-medium">Members</h2>
        <Link to="/admin/invitations" className="text-sm font-medium text-brand hover:underline">
          Invite people
        </Link>
      </div>
      {members.isPending ? (
        <div className="p-5">
          <Spinner />
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr className="border-b border-slate-100">
              <th className="px-5 py-2 font-medium">Person</th>
              <th className="px-5 py-2 font-medium">Role</th>
              <th className="hidden px-5 py-2 font-medium md:table-cell">Last sign-in</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {members.data?.map((m) => {
              const self = m.userId === user?.id;
              const ownerLocked = m.role === 'owner' && user?.role !== 'owner';
              return (
                <tr key={m.userId}>
                  <td className="px-5 py-3">
                    <p className="font-medium">
                      {m.name} {self && <span className="text-xs text-slate-400">(you)</span>}
                    </p>
                    <p className="text-xs text-slate-500">{m.email}</p>
                  </td>
                  <td className="px-5 py-3">
                    {self || ownerLocked ? (
                      <Badge tone={ROLE_TONE[m.role]} className="capitalize">
                        {m.role}
                      </Badge>
                    ) : (
                      <Select
                        aria-label={`Role for ${m.name}`}
                        value={m.role}
                        className="w-32"
                        onChange={(e) =>
                          change.mutate({ userId: m.userId, role: e.target.value as Role })
                        }
                      >
                        {ROLES.filter((r) => r !== 'owner' || user?.role === 'owner').map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    )}
                  </td>
                  <td className="hidden px-5 py-3 text-slate-500 md:table-cell">
                    {m.lastLoginAt ? timeAgo(m.lastLoginAt) : 'Never'}
                  </td>
                  <td className="px-3">
                    {!self && !ownerLocked && (
                      <button
                        onClick={() =>
                          window.confirm(
                            `Remove ${m.name} from this workspace? Their sessions end immediately.`,
                          ) && remove.mutate(m.userId)
                        }
                        className="text-slate-400 hover:text-red-600"
                        aria-label={`Remove ${m.name}`}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---- invitations ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check /> : <Copy />} {done ? 'Copied' : 'Copy link'}
    </Button>
  );
}

function InvitationsPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [lastLink, setLastLink] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['invitations'],
    queryFn: async () => unwrap(await api.GET('/api/v1/invitations')).data,
  });
  const create = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST('/api/v1/invitations', { params: idempotent(), body: { email, role } }),
      ),
    onSuccess: async (inv) => {
      setLastLink(inv.acceptUrl);
      setEmail('');
      await qc.invalidateQueries({ queryKey: ['invitations'] });
      toast.success(`Invitation sent to ${inv.email}`);
    },
    onError,
  });
  const revoke = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/v1/invitations/{id}', { params: { path: { id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invitations'] }),
    onError,
  });
  const tone = { pending: 'amber', accepted: 'green', revoked: 'neutral', expired: 'red' } as const;

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <h2 className="mb-4 text-sm font-medium">Invite someone</h2>
        <form
          className="grid gap-3 sm:grid-cols-[1fr_10rem_auto]"
          onSubmit={(e: SyntheticEvent) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Input
            type="email"
            required
            placeholder="name@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Email"
          />
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
            {ROLES.filter((r) => r !== 'owner' || user?.role === 'owner').map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
          <Button type="submit" loading={create.isPending}>
            <Mail /> Send invite
          </Button>
        </form>
        {lastLink && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 p-3 text-xs">
            <span className="text-slate-500">
              Single-use link (also emailed — see Mailpit at localhost:8025):
            </span>
            <code className="min-w-0 flex-1 truncate">{lastLink}</code>
            <CopyButton text={lastLink} />
          </div>
        )}
      </Card>
      <Card>
        <ul className="divide-y divide-slate-100">
          {list.data?.length === 0 && (
            <li className="p-5 text-sm text-slate-500">No invitations yet.</li>
          )}
          {list.data?.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-5 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{i.email}</p>
                <p className="text-xs text-slate-500">
                  {i.role} · invited by {i.invitedBy ?? 'someone'} {timeAgo(i.createdAt)}
                </p>
              </div>
              <Badge tone={tone[i.status]}>{i.status}</Badge>
              {i.status === 'pending' && (
                <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// ---- branding --------------------------------------------------------------------------------

function BrandingPage() {
  const current = useBranding();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Branding>(current);
  // Leaving the page without saving restores the saved theme.
  useEffect(
    () => () => {
      applyBranding(qc.getQueryData<Branding>(['branding']) ?? current);
    },
    [],
  );
  const set = (patch: Partial<Branding>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    applyBranding(next); // live preview across the whole app
  };
  const setColor = (k: keyof Branding['colors'], v: string) =>
    set({ colors: { ...draft.colors, [k]: v } });

  const save = useMutation({
    mutationFn: async (logoFileId?: string | null) =>
      unwrap(
        await api.PUT('/api/v1/branding', {
          body: {
            hubTitle: draft.hubTitle,
            tagline: draft.tagline,
            colors: draft.colors,
            font: draft.font,
            ...(logoFileId !== undefined ? { logoFileId } : {}),
          },
        }),
      ),
    onSuccess: (b) => {
      qc.setQueryData(['branding'], b);
      setDraft(b);
      toast.success('Branding saved for everyone in this workspace');
    },
    onError,
  });

  const uploadLogo = async (file: File) => {
    try {
      const mime = file.type as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
      const ticket = unwrap(
        await api.POST('/api/v1/files/uploads', {
          params: idempotent(),
          body: { filename: file.name, mime, size: file.size, purpose: 'logo' },
        }),
      );
      const put = await fetch(ticket.uploadUrl, {
        method: 'PUT',
        headers: ticket.headers,
        body: file,
      });
      if (!put.ok) throw new Error('Upload failed');
      unwrap(
        await api.POST('/api/v1/files/{id}/complete', { params: { path: { id: ticket.file.id } } }),
      );
      save.mutate(ticket.file.id);
    } catch (err) {
      onError(err);
    }
  };

  const colorFields: [keyof Branding['colors'], string][] = [
    ['primary', 'Primary'],
    ['primaryForeground', 'Text on primary'],
    ['accent', 'Accent'],
    ['background', 'Page background'],
  ];

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
      <Card className="space-y-5 p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="hubTitle">Hub title</Label>
            <Input
              id="hubTitle"
              value={draft.hubTitle}
              onChange={(e) => set({ hubTitle: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="font">Font</Label>
            <Select
              id="font"
              value={draft.font}
              onChange={(e) => set({ font: e.target.value as Branding['font'] })}
            >
              {BRAND_FONTS.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor="tagline">Tagline</Label>
          <Input
            id="tagline"
            value={draft.tagline ?? ''}
            onChange={(e) => set({ tagline: e.target.value || null })}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          {colorFields.map(([k, label]) => (
            <div key={k}>
              <Label htmlFor={`c-${k}`}>{label}</Label>
              <div className="flex items-center gap-2">
                <input
                  id={`c-${k}`}
                  type="color"
                  value={draft.colors[k]}
                  onChange={(e) => setColor(k, e.target.value)}
                  className="h-9 w-10 cursor-pointer rounded border border-slate-200"
                />
                <code className="text-xs text-slate-500">{draft.colors[k]}</code>
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5">
          <label
            className={cn(
              'inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium shadow-sm hover:bg-slate-50',
            )}
          >
            <ImageUp className="size-4" /> Upload logo
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && void uploadLogo(e.target.files[0])}
            />
          </label>
          {current.logoUrl && (
            <Button variant="ghost" onClick={() => save.mutate(null)}>
              Remove logo
            </Button>
          )}
          <Button
            className="ml-auto"
            loading={save.isPending}
            onClick={() => save.mutate(undefined)}
          >
            Save branding
          </Button>
        </div>
      </Card>
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-slate-400 uppercase">
          Live preview
        </p>
        <Card className="overflow-hidden" style={{ background: draft.colors.background }}>
          <div className="flex items-center gap-2 border-b border-slate-200/70 bg-white px-4 py-3">
            <img
              src={
                draft.logoUrl ??
                monogramDataUrl(
                  draft.tenant.name,
                  draft.colors.primary,
                  draft.colors.primaryForeground,
                )
              }
              alt=""
              className="size-7 rounded-md"
            />
            <span className="text-sm font-semibold">{draft.hubTitle}</span>
          </div>
          <div
            className="m-4 rounded-xl p-5"
            style={{ background: draft.colors.primary, color: draft.colors.primaryForeground }}
          >
            <p className="text-lg font-semibold">{draft.hubTitle}</p>
            <p className="mt-1 text-xs opacity-90">{draft.tagline}</p>
            <span
              className="mt-4 inline-block rounded-md px-2 py-1 text-xs font-medium"
              style={{ background: draft.colors.accent, color: '#111' }}
            >
              Featured
            </span>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---- domains --------------------------------------------------------------------------------

function DomainsPage() {
  const qc = useQueryClient();
  const [hostname, setHostname] = useState('');
  const list = useQuery({
    queryKey: ['domains'],
    queryFn: async () => unwrap(await api.GET('/api/v1/domains')).data,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['domains'] });
  const add = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST('/api/v1/domains', { params: idempotent(), body: { hostname } })),
    onSuccess: async () => {
      setHostname('');
      await refresh();
    },
    onError,
  });
  const verify = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.POST('/api/v1/domains/{id}/verify', { params: { path: { id } } })),
    onSuccess: async (d) => {
      await refresh();
      toast.success(`${d.hostname} verified — it now routes to this workspace`);
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/v1/domains/{id}', { params: { path: { id } } })),
    onSuccess: refresh,
    onError,
  });

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <h2 className="text-sm font-medium">Custom domains</h2>
        <p className="mt-1 mb-4 text-sm text-slate-500">
          Point your own hostname at this workspace. It starts routing only after you prove
          ownership with a DNS TXT record. Locally, hostnames ending in <code>.localhost</code>{' '}
          verify instantly — try <code>portal.contoso-mfg.localhost</code>.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e: SyntheticEvent) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Input
            required
            placeholder="hub.example.com"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            aria-label="Hostname"
          />
          <Button type="submit" loading={add.isPending}>
            Add domain
          </Button>
        </form>
      </Card>
      {list.data?.length === 0 && <EmptyState icon={<Globe />} title="No custom domains yet" />}
      {list.data?.map((d) => (
        <Card key={d.id} className="p-5">
          <div className="flex flex-wrap items-center gap-3">
            <Globe className="size-5 text-brand" />
            <span className="font-medium">{d.hostname}</span>
            {d.verified ? (
              <Badge tone="green">
                <ShieldCheck className="size-3" /> Verified {formatDate(d.verifiedAt)}
              </Badge>
            ) : (
              <Badge tone="amber">Pending verification</Badge>
            )}
            <div className="ml-auto flex gap-2">
              {d.verified ? (
                <a
                  href={`${window.location.protocol}//${d.hostname}${window.location.port ? `:${window.location.port}` : ''}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-brand hover:underline"
                >
                  Open
                </a>
              ) : (
                <Button size="sm" loading={verify.isPending} onClick={() => verify.mutate(d.id)}>
                  Verify
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => remove.mutate(d.id)}
                aria-label={`Remove ${d.hostname}`}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
          {!d.verified && (
            <div className="mt-4 grid gap-2 rounded-lg bg-slate-50 p-3 font-mono text-xs sm:grid-cols-[4rem_1fr]">
              <span className="text-slate-400">Type</span>
              <span>{d.verification.type}</span>
              <span className="text-slate-400">Name</span>
              <span className="break-all">{d.verification.name}</span>
              <span className="text-slate-400">Value</span>
              <span className="break-all">{d.verification.value}</span>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

// ---- audit -----------------------------------------------------------------------------------

const ACTION_FILTERS = [
  '',
  'auth.',
  'resource.',
  'membership.',
  'invitation.',
  'branding.',
  'domain.',
  'file.',
  'platform.',
];

function AuditPage() {
  const [action, setAction] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['audit', action],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/api/v1/audit', {
          params: {
            query: {
              limit: 30,
              ...(action ? { 'filter[action]': action } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-3">
        <h2 className="text-sm font-medium">Audit log</h2>
        <span className="text-xs text-slate-400">
          Append-only. Even platform admins can’t edit it.
        </span>
        <Select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="ml-auto w-44"
          aria-label="Filter by action"
        >
          {ACTION_FILTERS.map((a) => (
            <option key={a} value={a}>
              {a ? `${a}*` : 'All actions'}
            </option>
          ))}
        </Select>
      </div>
      <ul className="divide-y divide-slate-100">
        {rows.map((e) => (
          <li
            key={e.id}
            className="grid gap-1 px-5 py-3 text-sm sm:grid-cols-[11rem_1fr_auto] sm:items-start sm:gap-4"
          >
            <code className="text-xs font-medium text-brand">{e.action}</code>
            <div className="min-w-0">
              <p className="text-slate-700">
                {e.actor ? (e.actor.name ?? 'Platform admin') : 'System'}
                {e.impersonator && (
                  <Badge tone="amber" className="ml-2">
                    via impersonation
                  </Badge>
                )}
                {e.entity && (
                  <span className="text-slate-400">
                    {' '}
                    · {e.entity}
                    {e.entityId ? ` …${e.entityId.slice(-8)}` : ''}
                  </span>
                )}
              </p>
              {e.diff && Object.keys(e.diff).length > 0 && (
                <p className="mt-0.5 truncate font-mono text-xs text-slate-500">
                  {JSON.stringify(e.diff)}
                </p>
              )}
            </div>
            <span className="text-xs whitespace-nowrap text-slate-400" title={e.createdAt}>
              {timeAgo(e.createdAt)} · {e.ip ?? '—'}
            </span>
          </li>
        ))}
      </ul>
      {q.hasNextPage && (
        <div className="border-t border-slate-100 p-3 text-center">
          <Button
            variant="ghost"
            size="sm"
            loading={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            Load older events
          </Button>
        </div>
      )}
    </Card>
  );
}

export function adminRoutes(parent: AnyRoute) {
  const layout = createRoute({
    getParentRoute: () => parent,
    path: '/admin',
    component: AdminLayout,
  });
  return [
    layout.addChildren([
      createRoute({ getParentRoute: () => layout, path: '/', component: MembersPage }),
      createRoute({
        getParentRoute: () => layout,
        path: '/invitations',
        component: InvitationsPage,
      }),
      createRoute({ getParentRoute: () => layout, path: '/branding', component: BrandingPage }),
      createRoute({ getParentRoute: () => layout, path: '/domains', component: DomainsPage }),
      createRoute({
        getParentRoute: () => layout,
        path: '/integrations',
        component: IntegrationsPage,
      }),
      createRoute({ getParentRoute: () => layout, path: '/audit', component: AuditPage }),
    ]),
  ];
}
