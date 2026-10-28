// Carte des Paramètres : 9 pages thématiques, chacune découpée en onglets. Source UNIQUE, lue par la
// sous-nav de la barre de titre (App), par la nav latérale et par le routeur (SettingsPanel) — sans
// elle les trois listes divergeraient. Données pures (ids + icônes + clés i18n) : aucun composant de
// page ici, sinon la barre de titre tirerait tout le code des Paramètres au démarrage.
import type { ComponentType } from "react";
import { AdobeLogo } from "@/components/HostIcon";
import { DiscordIcon } from "@/components/DiscordIcon";
import { settingsIcon } from "./settingsIcons";

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
    icon: settingsIcon("account"),
    tabs: [
      { id: "profile", icon: settingsIcon("profile") },
      { id: "discord", icon: DiscordIcon },
      // Sharing belongs to the ACCOUNT, not to a module: the device identity, the people, the
      // invitations and the projects are the same whichever page opened them.
      { id: "sharing", icon: settingsIcon("sharing") },
    ],
  },
  {
    id: "interface",
    icon: settingsIcon("interface"),
    tabs: [
      { id: "theme", icon: settingsIcon("theme") },
      { id: "language", icon: settingsIcon("language") },
      { id: "navigation", icon: settingsIcon("navigation") },
      { id: "notifications", icon: settingsIcon("notifications") },
    ],
  },
  {
    id: "media",
    icon: settingsIcon("media"),
    tabs: [{ id: "preview", icon: settingsIcon("preview") }],
  },
  {
    id: "ai",
    icon: settingsIcon("ai"),
    tabs: [
      { id: "models", icon: settingsIcon("models") },
      { id: "indexing", icon: settingsIcon("indexing") },
    ],
  },
  // Export et Adobe restent DEUX entrées de la nav : le pont Adobe est une destination qu'on cherche
  // par son nom — enfoui en onglet d'une page « Montage », il devenait introuvable.
  { id: "export", icon: settingsIcon("export"), tabs: [{ id: "export", icon: settingsIcon("export") }] },
  { id: "adobe", icon: AdobeLogo, tabs: [{ id: "adobe", icon: AdobeLogo, wide: true }] },
  {
    id: "storage",
    icon: settingsIcon("storage"),
    tabs: [
      { id: "media", icon: settingsIcon("media") },
      { id: "cleanup", icon: settingsIcon("cleanup") },
      { id: "project", icon: settingsIcon("project") },
      { id: "projects", icon: settingsIcon("projects") },
    ],
  },
  {
    id: "system",
    icon: settingsIcon("system"),
    tabs: [
      { id: "updates", icon: settingsIcon("updates") },
      { id: "compatibility", icon: settingsIcon("compatibility") },
      { id: "collaboration", icon: settingsIcon("collaboration") },
      { id: "console", icon: settingsIcon("console") },
    ],
  },
  // « À propos » est une DESTINATION qu'on cherche par son nom (identité de l'app, liens
  // communautaires, mentions légales) : enfouie en 4e onglet de « Système », elle était introuvable.
  { id: "about", icon: settingsIcon("about"), tabs: [{ id: "about", icon: settingsIcon("about") }] },
];

export function settingsPageDef(page: SettingsPage): SettingsPageDef {
  const def = SETTINGS_PAGES.find((p) => p.id === page);
  if (!def) throw new Error(`unknown settings page: ${page}`);
  return def;
}

/** Onglet ouvert par défaut sur chaque page = le premier de sa liste. */
export function defaultSettingsTabs(): Record<SettingsPage, string> {
  return Object.fromEntries(SETTINGS_PAGES.map((p) => [p.id, p.tabs[0].id])) as Record<SettingsPage, string>;
}
