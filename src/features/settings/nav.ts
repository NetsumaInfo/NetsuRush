// Carte des Paramètres : 9 pages thématiques, chacune découpée en onglets. Source UNIQUE, lue par la
// sous-nav de la barre de titre (App), par la nav latérale et par le routeur (SettingsPanel) — sans
// elle les trois listes divergeraient. Données pures (ids + icônes + clés i18n) : aucun composant de
// page ici, sinon la barre de titre tirerait tout le code des Paramètres au démarrage.
import {
  Boxes, Brush, Cpu, DatabaseBackup, Download, FolderKanban, HardDrive, Info,
  Languages, Mic, MonitorPlay, Palette, PanelLeft, RefreshCw, Scissors, Sparkles, Terminal,
  UserRound, Wrench,
} from "lucide-react";
import type { ComponentType } from "react";
import { AdobeLogo } from "@/components/HostIcon";
import { DiscordIcon } from "@/components/DiscordIcon";

export type SettingsPage = "account" | "interface" | "media" | "ai" | "export" | "adobe" | "storage" | "system" | "about";

type Icon = ComponentType<{ className?: string }>;

interface SettingsTabDef {
  id: string;
  icon: Icon;
  /** Rendu pleine largeur, hors de la colonne de lecture (pont Adobe : cartes de statut + snapshot). */
  wide?: boolean;
}

export interface SettingsPageDef {
  id: SettingsPage;
  icon: Icon;
  /** Une page à onglet unique n'affiche aucune sous-nav (cf. hasSettingsTabs). */
  tabs: SettingsTabDef[];
}

export function hasSettingsTabs(page: SettingsPage): boolean {
  return settingsPageDef(page).tabs.length > 1;
}

export const SETTINGS_PAGES: SettingsPageDef[] = [
  {
    id: "account",
    icon: UserRound,
    tabs: [
      { id: "profile", icon: UserRound },
      { id: "discord", icon: DiscordIcon },
    ],
  },
  {
    id: "interface",
    icon: Palette,
    tabs: [
      { id: "theme", icon: Palette },
      { id: "language", icon: Languages },
      { id: "navigation", icon: PanelLeft },
    ],
  },
  {
    id: "media",
    icon: MonitorPlay,
    tabs: [{ id: "preview", icon: MonitorPlay }],
  },
  {
    id: "ai",
    icon: Sparkles,
    tabs: [
      { id: "models", icon: Boxes },
      { id: "dictation", icon: Mic },
      { id: "indexing", icon: Scissors },
    ],
  },
  // Export et Adobe restent DEUX entrées de la nav : le pont Adobe est une destination qu'on cherche
  // par son nom — enfoui en onglet d'une page « Montage », il devenait introuvable.
  { id: "export", icon: Download, tabs: [{ id: "export", icon: Download }] },
  { id: "adobe", icon: AdobeLogo, tabs: [{ id: "adobe", icon: AdobeLogo, wide: true }] },
  {
    id: "storage",
    icon: HardDrive,
    tabs: [
      { id: "media", icon: HardDrive },
      { id: "cleanup", icon: Brush },
      { id: "project", icon: DatabaseBackup },
      { id: "projects", icon: FolderKanban },
    ],
  },
  {
    id: "system",
    icon: Wrench,
    tabs: [
      { id: "updates", icon: RefreshCw },
      { id: "compatibility", icon: Cpu },
      { id: "console", icon: Terminal },
    ],
  },
  // « À propos » est une DESTINATION qu'on cherche par son nom (identité de l'app, liens
  // communautaires, mentions légales) : enfouie en 4e onglet de « Système », elle était introuvable.
  { id: "about", icon: Info, tabs: [{ id: "about", icon: Info }] },
];

export function settingsPageDef(page: SettingsPage): SettingsPageDef {
  const def = SETTINGS_PAGES.find((p) => p.id === page);
  if (!def) throw new Error(`page de paramètres inconnue : ${page}`);
  return def;
}

/** Onglet ouvert par défaut sur chaque page = le premier de sa liste. */
export function defaultSettingsTabs(): Record<SettingsPage, string> {
  return Object.fromEntries(SETTINGS_PAGES.map((p) => [p.id, p.tabs[0].id])) as Record<SettingsPage, string>;
}
