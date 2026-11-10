import type { Role } from '../schema/tenancy.js';

/**
 * Demo data shared by `pnpm db:seed`, the dev identity provider's "sign in as" screen,
 * and the isolation tests. Two tenants with deliberately different branding and content,
 * plus one person who belongs to both, so cross-tenant behaviour is easy to show.
 */
export interface DemoTenant {
  id: string;
  slug: string;
  name: string;
  plan: 'free' | 'pro' | 'enterprise';
}

export interface DemoUser {
  id: string;
  /** Subject id at the identity provider (Entra object id in production). */
  oid: string;
  email: string;
  name: string;
  title: string;
  isPlatformAdmin?: boolean;
  memberships: { tenant: string; role: Role }[];
}

export const DEMO_TENANTS = {
  contoso: {
    id: '01960000-0000-7000-8000-00000000c001',
    slug: 'contoso',
    name: 'Contoso Pharma',
    plan: 'enterprise',
  },
  northwind: {
    id: '01960000-0000-7000-8000-00000000a001',
    slug: 'northwind',
    name: 'Northwind Health',
    plan: 'pro',
  },
} as const satisfies Record<string, DemoTenant>;

export type DemoTenantKey = keyof typeof DEMO_TENANTS;

export const DEMO_USERS: DemoUser[] = [
  {
    id: '01960000-0000-7000-8000-0000000000a1',
    oid: 'dev-olivia',
    email: 'olivia@contoso.example',
    name: 'Olivia Owens',
    title: 'Owner · Contoso',
    memberships: [{ tenant: 'contoso', role: 'owner' }],
  },
  {
    id: '01960000-0000-7000-8000-0000000000a2',
    oid: 'dev-adam',
    email: 'adam@contoso.example',
    name: 'Adam Alvarez',
    title: 'Admin · Contoso',
    memberships: [{ tenant: 'contoso', role: 'admin' }],
  },
  {
    id: '01960000-0000-7000-8000-0000000000a3',
    oid: 'dev-erin',
    email: 'erin@contoso.example',
    name: 'Erin Edwards',
    title: 'Editor · Contoso',
    memberships: [{ tenant: 'contoso', role: 'editor' }],
  },
  {
    id: '01960000-0000-7000-8000-0000000000a4',
    oid: 'dev-victor',
    email: 'victor@contoso.example',
    name: 'Victor Vance',
    title: 'Viewer · Contoso',
    memberships: [{ tenant: 'contoso', role: 'viewer' }],
  },
  {
    id: '01960000-0000-7000-8000-0000000000b1',
    oid: 'dev-nora',
    email: 'nora@northwind.example',
    name: 'Nora Nguyen',
    title: 'Owner · Northwind',
    memberships: [{ tenant: 'northwind', role: 'owner' }],
  },
  {
    id: '01960000-0000-7000-8000-0000000000b2',
    oid: 'dev-ned',
    email: 'ned@northwind.example',
    name: 'Ned Norris',
    title: 'Editor · Northwind',
    memberships: [{ tenant: 'northwind', role: 'editor' }],
  },
  {
    id: '01960000-0000-7000-8000-0000000000c1',
    oid: 'dev-sam',
    email: 'sam@consultant.example',
    name: 'Sam Sharma',
    title: 'Viewer · Contoso, Admin · Northwind',
    memberships: [
      { tenant: 'contoso', role: 'viewer' },
      { tenant: 'northwind', role: 'admin' },
    ],
  },
  {
    id: '01960000-0000-7000-8000-0000000000f1',
    oid: 'dev-pat',
    email: 'pat@resourcehub.example',
    name: 'Pat Platform',
    title: 'Platform admin (admin host only)',
    isPlatformAdmin: true,
    memberships: [],
  },
];
