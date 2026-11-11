import {
  BadgeCheck,
  Building2,
  ClipboardList,
  Factory,
  Folder,
  GraduationCap,
  Palette,
  Scale,
  ShoppingBag,
  Store,
  Truck,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useBranding, monogramDataUrl } from '@/lib/branding';
import { cn } from '@/lib/utils';

const ICONS: Record<string, LucideIcon> = {
  factory: Factory,
  'badge-check': BadgeCheck,
  wrench: Wrench,
  'graduation-cap': GraduationCap,
  palette: Palette,
  store: Store,
  'shopping-bag': ShoppingBag,
  truck: Truck,
  scale: Scale,
  'clipboard-list': ClipboardList,
  'building-2': Building2,
  users: Users,
};

export const CATEGORY_ICON_NAMES = Object.keys(ICONS);

export function CategoryIcon({
  name,
  className,
}: {
  name: string | null | undefined;
  className?: string;
}) {
  const Icon = (name && ICONS[name]) || Folder;
  return <Icon className={className} />;
}

/** Tenant logo, or a monogram in the brand color when no logo is uploaded. */
export function BrandMark({ className }: { className?: string }) {
  const b = useBranding();
  return (
    <img
      src={
        b.logoUrl ?? monogramDataUrl(b.tenant.name, b.colors.primary, b.colors.primaryForeground)
      }
      alt={`${b.tenant.name} logo`}
      className={cn('size-8 rounded-lg object-contain', className)}
    />
  );
}
