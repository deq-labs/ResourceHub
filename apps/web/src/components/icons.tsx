import {
  Building2,
  ClipboardList,
  FlaskConical,
  Folder,
  GraduationCap,
  HeartPulse,
  Palette,
  Scale,
  Stethoscope,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useBranding, monogramDataUrl } from '@/lib/branding';
import { cn } from '@/lib/utils';

const ICONS: Record<string, LucideIcon> = {
  'flask-conical': FlaskConical,
  scale: Scale,
  stethoscope: Stethoscope,
  'graduation-cap': GraduationCap,
  palette: Palette,
  'heart-pulse': HeartPulse,
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
