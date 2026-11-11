/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- a route referencing itself inside its own component is inferred as any by TanStack; the assertions restore the types. */
import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  useLocation,
} from '@tanstack/react-router';
import { AppShell } from '@/components/AppShell';
import { PageSpinner } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { HomePage } from '@/routes/home';
import { ResourcesPage, type ResourceSearch } from '@/routes/resources';
import { ResourceDetailPage } from '@/routes/resource-detail';
import { ResourceEditorPage } from '@/routes/resource-editor';
import { TaxonomyPage } from '@/routes/taxonomy';
import { InvitePage, NoAccessPage, NotFoundPage, SignInPage } from '@/routes/public-pages';
import { adminRoutes } from '@/routes/admin';
import { RequireRole } from '@/components/RequireRole';

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
    const { error, returnTo } = signInRoute.useSearch() as { error?: string; returnTo?: string };
    const { state } = useAuth();
    if (state.status === 'authenticated') return <Navigate to={returnTo ?? '/'} />;
    return <SignInPage {...(error ? { error } : {})} {...(returnTo ? { returnTo } : {})} />;
  },
});

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: function Invite() {
    const { token } = inviteRoute.useParams() as { token: string };
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
    return <ResourcesPage search={resourcesRoute.useSearch() as ResourceSearch} />;
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
    const { slug } = resourceRoute.useParams() as { slug: string };
    return <ResourceDetailPage slug={slug} />;
  },
});

const editResourceRoute = createRoute({
  getParentRoute: () => memberRoute,
  path: '/resources/$slug/edit',
  component: function EditResource() {
    const { slug } = editResourceRoute.useParams() as { slug: string };
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
