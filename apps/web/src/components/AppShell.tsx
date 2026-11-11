import { useState, type SyntheticEvent, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import {
  ArrowLeftRight,
  ChevronDown,
  LogOut,
  Search,
  Settings,
  ShieldAlert,
  Tags,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useBranding } from '@/lib/branding';
import { meQuery } from '@/lib/queries';
import { cn, workspaceUrl } from '@/lib/utils';
import { BrandMark } from './icons';
import { Badge } from './ui';

function NavLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-900/5 hover:text-slate-900"
      activeProps={{ className: 'bg-brand/10 !text-brand' }}
      activeOptions={{ exact: to === '/' }}
    >
      {children}
    </Link>
  );
}

function HeaderSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    void navigate({ to: '/resources', search: q ? { q } : {} });
  };
  return (
    <form onSubmit={submit} className="relative hidden md:block">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search resources…"
        aria-label="Search resources"
        className="h-9 w-64 rounded-lg border border-slate-200 bg-white/70 pr-3 pl-9 text-sm focus:w-80 focus:border-brand focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand/20 transition-all"
      />
    </form>
  );
}

function UserMenu() {
  const { user, signOut } = useAuth();
  const me = useQuery({ ...meQuery(), enabled: !!user });
  const b = useBranding();
  if (!user) return null;
  const others = (me.data?.workspaces ?? []).filter((w) => w.slug !== b.tenant.slug);
  const initials = user.name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('');
  return (
    <Dropdown.Root>
      <Dropdown.Trigger className="flex items-center gap-2 rounded-full py-1 pr-2 pl-1 text-sm hover:bg-slate-900/5 focus:outline-none">
        <span className="grid size-8 place-items-center rounded-full bg-brand text-xs font-semibold text-brand-foreground">
          {initials}
        </span>
        <span className="hidden text-left leading-tight sm:block">
          <span className="block font-medium text-slate-800">{user.name}</span>
          <span className="block text-xs text-slate-500 capitalize">
            {user.role ?? 'no access'}
          </span>
        </span>
        <ChevronDown className="size-4 text-slate-400" />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align="end"
          sideOffset={8}
          className="z-50 w-72 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg"
        >
          <div className="px-2.5 py-2">
            <p className="text-sm font-medium">{user.name}</p>
            <p className="text-xs text-slate-500">{user.email}</p>
          </div>
          {others.length > 0 && (
            <>
              <Dropdown.Separator className="my-1 h-px bg-slate-100" />
              <Dropdown.Label className="px-2.5 pt-1.5 pb-1 text-xs font-medium tracking-wide text-slate-400 uppercase">
                Switch workspace
              </Dropdown.Label>
              {others.map((w) => (
                <Dropdown.Item key={w.tenantId} asChild>
                  <a
                    href={workspaceUrl(w.slug)}
                    className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-slate-100"
                  >
                    <ArrowLeftRight className="size-4 text-slate-400" />
                    <span className="flex-1">{w.name}</span>
                    <Badge className="capitalize">{w.role}</Badge>
                  </a>
                </Dropdown.Item>
              ))}
            </>
          )}
          <Dropdown.Separator className="my-1 h-px bg-slate-100" />
          <Dropdown.Item
            onSelect={() => void signOut()}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-red-600 outline-none data-[highlighted]:bg-red-50"
          >
            <LogOut className="size-4" /> Sign out
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function ImpersonationBanner() {
  const { user, signOut } = useAuth();
  if (!user?.impersonatedBy) return null;
  return (
    <div className="flex items-center justify-center gap-3 bg-amber-400 px-4 py-2 text-sm font-medium text-amber-950">
      <ShieldAlert className="size-4" />
      {user.impersonatedBy.name} is viewing as {user.name}. Every action is audited.
      <button
        onClick={() => void signOut()}
        className="rounded-md bg-amber-950/10 px-2 py-0.5 hover:bg-amber-950/20"
      >
        End session
      </button>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const b = useBranding();
  const { can } = useAuth();
  return (
    <div className="flex min-h-screen flex-col">
      <ImpersonationBanner />
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandMark />
            <span className="font-semibold tracking-tight text-slate-900">{b.hubTitle}</span>
          </Link>
          <nav className="flex items-center gap-1">
            <NavLink to="/">Home</NavLink>
            <NavLink to="/resources">Resources</NavLink>
            {can('editor') && (
              <NavLink to="/manage/taxonomy">
                <span className="inline-flex items-center gap-1.5">
                  <Tags className="size-4" /> Taxonomy
                </span>
              </NavLink>
            )}
            {can('admin') && (
              <NavLink to="/admin">
                <span className="inline-flex items-center gap-1.5">
                  <Settings className="size-4" /> Admin
                </span>
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <HeaderSearch />
            <UserMenu />
          </div>
        </div>
      </header>
      <main className={cn('mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6')}>{children}</main>
      <footer className="border-t border-slate-200/70 py-6 text-center text-xs text-slate-400">
        {b.tenant.name} · Powered by ResourceHub · Workspace{' '}
        <code className="font-mono">{window.location.host}</code>
      </footer>
    </div>
  );
}
