import type { ComponentType } from "react";
import { NetsuIcon } from "@/components/ui/netsu-icon";

export type IconComponent = ComponentType<{ className?: string }>;

/** A component for one NetsuIcon id, for registries that store components (settings map, menus). */
export function netsuIconOf(name: string): IconComponent {
  return function NamedNetsuIcon({ className }) {
    return <NetsuIcon name={name} className={className} />;
  };
}
