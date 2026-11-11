import type { ReactNode } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  useLocation,
} from '@tanstack/react-router';
import type { Role } from '@resourcehub/contracts';
import { AppShell } from '@/components/AppShell';
import { EmptyState, PageSpinner } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { HomePage } from '@/routes/home';
import { ResourcesPage, type ResourceSearch } from '@/routes/resources';
import { ResourceDetailPage } from '@/routes/resource-detail';
import { ResourceEditorPage } from '@/routes/resource-editor';
import { TaxonomyPage } from '@/routes/taxonomy';
import { InvitePage, NoAccessPage, NotFoundPage, SignInPage } from '@/routes/public-pages';
import { adminRoutes } from '@/routes/admin';
import { ShieldOff } from 'lucide-react';

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: NotFoundPage,
});

// ---- public -------------------------------------------------------------------------------

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signin',
  validateSearch: (s: Record<string, unknown>): { error?: string; returnTo?: string } => ({
    error: str(s.error),
    returnTo: str(s.returnTo),
  }),
  component: function SignIn() {
    const { error, returnTo } = signInRoute.useSearch();
    const { state } = useAuth();
    if (state.status === 'authenticated') return <Navigate to={returnTo ?? '/'} />;
    return <SignInPage {...(error ? { error } : {})} {...(returnTo ? { returnTo } : {})} />;
  },
});

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: function Invite() {
    const { token } = inviteRoute.useParams();
    return <InvitePage token={token} />;
  },
});

// ---- signed-in member area -----------------------------------------------------------------

function MemberLayout() {
  const { state, user } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <PageSpinner />;
  // Render sign-in in place (no redirect): the URL is kept as the post-login returnTo.
  if (state.status === 'anonymous') return <SignInPage returnTo={location.href} />;
  if (!user?.role) return <NoAccessPage />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export function RequireRole({ min, children }: { min: Role; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(min)) {
    return (
      <EmptyState icon={<ShieldOff />} title="You don't have access to this page">
        It needs the {min} role or higher.
      </EmptyState>
    );
  }
  return <>{children}</>;
}

export const memberRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'member',
  component: MemberLayout,
});

const homeRoute = createRoute({
  getParentRoute: () => memberRoute,
  path: '/',
  component: HomePage,
});

const resourcesRoute = createRoute({
  getParentRoute: () => memberRoute,
  path: '/resources',
  validateSearch: (s: Record<string, unknown>): ResourceSearch => {
    const status = str(s.status);
    return {
      q: str(s.q),
      category: str(s.category),
      tag: str(s.tag),
      status:
        status === 'draft' || status === 'published' || status === 'archived' ? status : undefined,
    };
  },
  component: function Resources() {
    return <ResourcesPage search={resourcesRoute.useSearch()} />;
  },
});

const newResourceRoute = createRoute({
  getParentRoute: () => memberRoute,
  path: '/resources/new',
  component: () => (
    <RequireRole min="editor">
      <ResourceEditorPage />
    </RequireRole>
  ),
});

const resourceRoute = createRoute({
  getParentRoute: () => memberRoute,
  path: '/resources/$slug',
  component: function Resource() {
    const { slug } = resourceRoute.useParams();
    return <ResourceDetailPage slug={slug} />;
  },
});

const editResourceRoute = createRoute({
  getParentRoute: () => memberRoute,
  path: '/resources/$slug/edit',
  component: function EditResource() {
    const { slug } = editResourceRoute.useParams();
    return (
      <RequireRole min="editor">
        <ResourceEditorPage slug={slug} />
      </RequireRole>
    );
  },
});

const taxonomyRoute = createRoute({
  getParentRoute: () => memberRoute,
  path: '/manage/taxonomy',
  component: () => (
    <RequireRole min="editor">
      <TaxonomyPage />
    </RequireRole>
  ),
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  inviteRoute,
  memberRoute.addChildren([
    homeRoute,
    resourcesRoute,
    newResourceRoute,
    resourceRoute,
    editResourceRoute,
    taxonomyRoute,
    ...adminRoutes(memberRoute),
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
