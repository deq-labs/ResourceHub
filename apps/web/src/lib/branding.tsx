import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Branding } from '@resourcehub/contracts';
import { api, ApiError, unwrap } from './api';

const BrandingContext = createContext<Branding | null>(null);

const FONT_FAMILY: Record<Branding['font'], string> = {
  Inter: 'Inter',
  'IBM Plex Sans': 'IBM+Plex+Sans',
  'Nunito Sans': 'Nunito+Sans',
  'Source Sans 3': 'Source+Sans+3',
  'Work Sans': 'Work+Sans',
  Lora: 'Lora',
  Merriweather: 'Merriweather',
};

/** Push the tenant's theme tokens into CSS variables; Tailwind's brand-* utilities read them. */
export function applyBranding(b: Branding): void {
  const root = document.documentElement.style;
  root.setProperty('--brand-primary', b.colors.primary);
  root.setProperty('--brand-primary-foreground', b.colors.primaryForeground);
  root.setProperty('--brand-accent', b.colors.accent);
  root.setProperty('--brand-background', b.colors.background);
  root.setProperty('--brand-font', `'${b.font}'`);
  document.title = b.hubTitle;

  // Fonts come only from the allowlisted Google Fonts CDN (also allowed by the CSP).
  const id = 'brand-font';
  const href = `https://fonts.googleapis.com/css2?family=${FONT_FAMILY[b.font]}:wght@400;500;600;700&display=swap`;
  let link = document.getElementById(id) as HTMLLinkElement | null;
  if (!link) {
    link = Object.assign(document.createElement('link'), { id, rel: 'stylesheet' });
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;

  let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!icon) {
    icon = Object.assign(document.createElement('link'), { rel: 'icon' });
    document.head.appendChild(icon);
  }
  icon.href =
    b.logoUrl ?? monogramDataUrl(b.tenant.name, b.colors.primary, b.colors.primaryForeground);
}

export function monogramDataUrl(name: string, bg: string, fg: string): string {
  const letter = (name.trim()[0] ?? 'R').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="system-ui,sans-serif" font-size="36" font-weight="700" fill="${fg}">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function useBrandingQuery() {
  return useQuery({
    queryKey: ['branding'],
    queryFn: async () => unwrap(await api.GET('/api/v1/branding')),
    staleTime: 5 * 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.problem.status === 404) && count < 2,
  });
}

export function BrandingProvider({
  branding,
  children,
}: {
  branding: Branding;
  children: ReactNode;
}) {
  useEffect(() => {
    applyBranding(branding);
  }, [branding]);
  return <BrandingContext.Provider value={branding}>{children}</BrandingContext.Provider>;
}

export function useBranding(): Branding {
  const b = useContext(BrandingContext);
  if (!b) throw new Error('useBranding outside BrandingProvider');
  return b;
}
