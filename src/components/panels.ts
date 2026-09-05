// Table onglet → panneau. SOURCE UNIQUE : `MainContent` monte ces composants et le préchargement
// réutilise EXACTEMENT les mêmes `import()` — deux listes divergeraient, et un chargeur oublié
// ferait réapparaître l'attente sur la page concernée.
//
// Chaque panneau est un chunk séparé (le carnet pèse à lui seul 1,5 Mo) : les charger tous à
// l'entrée rallongerait le démarrage pour des pages que l'utilisateur n'ouvrira peut-être pas.
// Ils sont donc récupérés pendant les TEMPS MORTS, un par un, après l'affichage de la première
// page — le changement d'onglet devient instantané sans rien coûter au démarrage.
import { lazy, type ComponentType } from "react";
import type { TabId } from "@/store";

const load = {
  derush: () => import("@/components/rushes/DerushTab").then((m) => ({ default: m.DerushTab })),
  search: () => import("@/components/search/SearchPanel").then((m) => ({ default: m.SearchPanel })),
  reference: () => import("@/components/reference/ReferencePanel").then((m) => ({ default: m.ReferencePanel })),
  notebook: () => import("@/components/notebook/NotebookPanel").then((m) => ({ default: m.NotebookPanel })),
  script: () => import("@/components/script/ScriptPanel").then((m) => ({ default: m.ScriptPanel })),
  upscale: () => import("@/components/netsulab/NetsuLabPanel").then((m) => ({ default: m.NetsuLabPanel })),
  voice: () => import("@/components/voice/VoicePanel").then((m) => ({ default: m.VoicePanel })),
  chat: () => import("@/components/chat/ChatPanel").then((m) => ({ default: m.ChatPanel })),
  flow: () => import("@/components/flow/FlowPanel").then((m) => ({ default: m.FlowPanel })),
  optimisation: () => import("@/components/optimize/OptimizePanel").then((m) => ({ default: m.OptimizePanel })),
  transfer: () => import("@/components/transfer/TransferPanel").then((m) => ({ default: m.TransferPanel })),
  settings: () => import("@/components/settings/SettingsPanel").then((m) => ({ default: m.SettingsPanel })),
} satisfies Partial<Record<TabId, () => Promise<{ default: ComponentType }>>>;

export type PanelTab = keyof typeof load;

export const PANELS = Object.fromEntries(
  (Object.keys(load) as PanelTab[]).map((id) => [id, lazy(load[id])] as const),
) as unknown as Record<PanelTab, ComponentType>;

export function hasPanel(tab: TabId): tab is PanelTab {
  return tab in load;
}

/** Charge le chunk d'un onglet sans l'afficher. Idempotent : le navigateur sert le même module. */
export function prefetchPanel(tab: TabId) {
  if (hasPanel(tab)) void load[tab]().catch(() => { /* réessayé au montage réel */ });
}

// Une page à la fois, et seulement quand le fil est libre : le préchargement ne doit jamais
// concurrencer un décodage vidéo ni la page que l'utilisateur regarde.
function whenIdle(run: () => void) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => run(), { timeout: 3000 });
  else setTimeout(run, 300);
}

let started = false;
export function prefetchPanelsWhenIdle(current?: TabId) {
  if (started) return;
  started = true;
  const queue = (Object.keys(load) as PanelTab[]).filter((id) => id !== current);
  const step = () => {
    const id = queue.shift();
    if (!id) return;
    void load[id]().catch(() => { /* chunk indisponible : le montage réel refera la demande */ })
      .then(() => whenIdle(step));
  };
  whenIdle(step);
}
