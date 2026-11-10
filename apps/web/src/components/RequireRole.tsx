import type { ReactNode } from 'react';
import type { Role } from '@resourcehub/contracts';
import { ShieldOff } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { EmptyState } from './ui';

/** UI-level role gate. The API enforces the same rule; this only avoids showing dead ends. */
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
