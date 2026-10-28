import { netsuIconOf, type IconComponent } from "@/components/NetsuIconOf";

/** The NetsuIcon `settings-<id>` as a component: the settings map stores components, not ids. */
export function settingsIcon(id: string): IconComponent {
  return netsuIconOf(`settings-${id}`);
}
