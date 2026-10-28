import type { ModuleId } from "@/lib/modules";
import {
  NavBookIcon, NavBoostIcon, NavBridgeIcon, NavCutIcon, NavLabIcon, NavPilotIcon, NavSearchIcon, type NavIcon,
} from "@/components/navIcons";

// Navigation latérale — partagée avec App (lookup du libellé de l'onglet actif).
export const NAV: { id: ModuleId; label: string; labelKey: string; icon: NavIcon }[] = [
  { id: "derush", label: "NetsuCut", labelKey: "nav.derush", icon: NavCutIcon },
  { id: "search", label: "NetsuSearch", labelKey: "nav.search", icon: NavSearchIcon },
  { id: "notebook", label: "NetsuBook", labelKey: "nav.notebook", icon: NavBookIcon },
  { id: "upscale", label: "NetsuLab", labelKey: "nav.upscale", icon: NavLabIcon },
  { id: "chat", label: "NetsuPilot", labelKey: "nav.chat", icon: NavPilotIcon },
  { id: "optimisation", label: "NetsuBoost", labelKey: "nav.optimisation", icon: NavBoostIcon },
  { id: "transfer", label: "NetsuBridge", labelKey: "nav.transfer", icon: NavBridgeIcon },
];
