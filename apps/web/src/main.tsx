import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { Toaster } from 'sonner';
import { PageSpinner } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { AuthProvider } from '@/lib/auth';
import { BrandingProvider, useBrandingQuery } from '@/lib/branding';
import { PLATFORM_HOST } from '@/lib/utils';
import { router } from '@/router';
import { WorkspaceMissingPage } from '@/routes/public-pages';
import { PlatformApp } from '@/platform/PlatformApp';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.problem.status < 500) && count < 2,
    },
  },
});

/** Tenant host: load the theme first (it is public), then the app. */
function TenantApp() {
  const branding = useBrandingQuery();
  if (branding.isPending) return <PageSpinner />;
  if (branding.error) {
    const suspended = branding.error instanceof ApiError && branding.error.problem.status === 403;
    return <WorkspaceMissingPage suspended={suspended} />;
  }
  return (
    <BrandingProvider branding={branding.data}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </BrandingProvider>
  );
}

const isPlatformHost = window.location.hostname === PLATFORM_HOST;

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {isPlatformHost ? <PlatformApp /> : <TenantApp />}
      <Toaster richColors position="bottom-right" />
    </QueryClientProvider>
  </StrictMode>,
);
