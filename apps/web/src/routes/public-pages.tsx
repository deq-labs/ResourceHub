import { useQuery, useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { KeyRound, Lock, LogIn, MailCheck, SearchX, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { BrandMark } from '@/components/icons';
import { Badge, Button, buttonVariants, Card, PageSpinner } from '@/components/ui';
import { api, errorMessage, unwrap } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBranding } from '@/lib/branding';
import { formatDate } from '@/lib/utils';

const ERRORS: Record<string, string> = {
  signin_cancelled: 'Sign-in was cancelled.',
  signin_expired: 'The sign-in attempt expired. Please try again.',
  signin_state_mismatch: 'The sign-in response did not match this browser session.',
  signin_failed: 'The identity provider rejected the sign-in.',
  not_platform_admin: 'That account is not a platform administrator.',
};

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-canvas px-4">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-brand opacity-90" />
      <Card className="relative w-full max-w-md p-8 shadow-xl">{children}</Card>
    </div>
  );
}

export function SignInPage({ error, returnTo }: { error?: string; returnTo?: string }) {
  const b = useBranding();
  const { signIn } = useAuth();
  return (
    <CenteredCard>
      <BrandMark className="mb-5 size-12" />
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to {b.hubTitle}</h1>
      <p className="mt-1 text-sm text-slate-500">{b.tenant.name} workspace</p>
      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {ERRORS[error] ?? 'Sign-in failed.'}
        </p>
      )}
      <Button size="lg" className="mt-6 w-full" onClick={() => signIn(returnTo ?? '/')}>
        <LogIn /> Continue with single sign-on
      </Button>
      <div className="mt-6 space-y-2 text-xs text-slate-500">
        <p className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-brand" /> OpenID Connect with PKCE. Tokens never touch
          browser storage.
        </p>
        <p className="flex items-center gap-2">
          <KeyRound className="size-4 text-brand" /> Locally this uses the built-in dev identity
          provider; in Azure, Entra External ID.
        </p>
      </div>
    </CenteredCard>
  );
}

export function NoAccessPage() {
  const b = useBranding();
  const { user, signOut } = useAuth();
  return (
    <CenteredCard>
      <Lock className="mb-4 size-10 text-brand" />
      <h1 className="text-xl font-semibold">No access to {b.tenant.name}</h1>
      <p className="mt-2 text-sm text-slate-600">
        You’re signed in as <strong>{user?.email}</strong>, but that account isn’t a member of this
        workspace. Ask an admin to send you an invitation.
      </p>
      <Button variant="secondary" className="mt-6" onClick={() => void signOut()}>
        Sign in with a different account
      </Button>
    </CenteredCard>
  );
}

export function InvitePage({ token }: { token: string }) {
  const { state, signIn, reload } = useAuth();
  const navigate = useNavigate();
  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/invitations/preview', { params: { query: { token } } })),
    retry: false,
  });
  const accept = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST('/api/v1/invitations/accept', { body: { token } })),
    onSuccess: async () => {
      await reload(); // new access token carries the new role
      toast.success('Welcome aboard!');
      void navigate({ to: '/' });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (preview.isPending || state.status === 'loading') return <PageSpinner />;
  if (preview.error) {
    return (
      <CenteredCard>
        <SearchX className="mb-4 size-10 text-slate-400" />
        <h1 className="text-xl font-semibold">Invitation not available</h1>
        <p className="mt-2 text-sm text-slate-600">{errorMessage(preview.error)}</p>
      </CenteredCard>
    );
  }
  const inv = preview.data;
  return (
    <CenteredCard>
      <MailCheck className="mb-4 size-10 text-brand" />
      <h1 className="text-xl font-semibold">Join {inv.workspace}</h1>
      <p className="mt-2 text-sm text-slate-600">
        You’ve been invited as{' '}
        <Badge tone="brand" className="capitalize">
          {inv.role}
        </Badge>
        . This invitation was sent to <strong>{inv.emailHint}</strong> and expires{' '}
        {formatDate(inv.expiresAt)}.
      </p>
      {state.status === 'authenticated' ? (
        <Button
          size="lg"
          className="mt-6 w-full"
          loading={accept.isPending}
          onClick={() => accept.mutate()}
        >
          Accept invitation
        </Button>
      ) : (
        <Button size="lg" className="mt-6 w-full" onClick={() => signIn(`/invite/${token}`)}>
          <LogIn /> Sign in to accept
        </Button>
      )}
    </CenteredCard>
  );
}

export function NotFoundPage() {
  return (
    <div className="grid min-h-[50vh] place-items-center text-center">
      <div>
        <p className="text-sm font-semibold text-brand">404</p>
        <h1 className="mt-1 text-2xl font-semibold">Page not found</h1>
        <Link to="/" className={buttonVariants({ variant: 'secondary', className: 'mt-6' })}>
          Back home
        </Link>
      </div>
    </div>
  );
}

/** Rendered when GET /branding 404s: the Host doesn't map to any tenant. */
export function WorkspaceMissingPage() {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 px-4 text-center">
      <div className="max-w-md">
        <SearchX className="mx-auto mb-4 size-10 text-slate-400" />
        <h1 className="text-2xl font-semibold">No workspace here</h1>
        <p className="mt-2 text-sm text-slate-600">
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5">{window.location.host}</code>{' '}
          isn’t connected to a ResourceHub workspace.
        </p>
        <p className="mt-6 text-sm text-slate-500">
          Try{' '}
          <a
            className="text-blue-600 hover:underline"
            href={`${window.location.protocol}//contoso.localhost:${window.location.port}`}
          >
            contoso.localhost
          </a>{' '}
          or{' '}
          <a
            className="text-blue-600 hover:underline"
            href={`${window.location.protocol}//northwind.localhost:${window.location.port}`}
          >
            northwind.localhost
          </a>
          .
        </p>
      </div>
    </div>
  );
}
