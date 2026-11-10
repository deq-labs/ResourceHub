import { createRoute, type AnyRoute } from '@tanstack/react-router';
import { Settings } from 'lucide-react';
import { EmptyState } from '@/components/ui';

/** Tenant admin pages (members, invitations, branding, domains, audit) arrive in Phase 4. */
export function adminRoutes(parent: AnyRoute) {
  return [
    createRoute({
      getParentRoute: () => parent,
      path: '/admin',
      component: () => (
        <EmptyState icon={<Settings />} title="Workspace admin">
          Members, branding, domains and the audit log live here.
        </EmptyState>
      ),
    }),
  ];
}
