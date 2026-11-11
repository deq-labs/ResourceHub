import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { Role } from '@resourcehub/contracts';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };
export function roleAtLeast(role: string | undefined, min: Role): boolean {
  return role !== undefined && Object.hasOwn(RANK, role) && RANK[role as Role] >= RANK[min];
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, secs] of units) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return 'just now';
}

export function formatDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const PLATFORM_HOST =
  (import.meta.env.VITE_PLATFORM_HOST as string | undefined) ?? 'admin.localhost';
export const ROOT_DOMAIN = (import.meta.env.VITE_ROOT_DOMAIN as string | undefined) ?? 'localhost';

/** URL of another workspace on the same root domain (keeps scheme and port). */
export function workspaceUrl(slug: string, path = '/'): string {
  const { protocol, port } = window.location;
  return `${protocol}//${slug}.${ROOT_DOMAIN}${port ? `:${port}` : ''}${path}`;
}
