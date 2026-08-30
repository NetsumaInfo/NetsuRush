// Paramètres : 8 pages thématiques dans la nav de gauche, la plupart découpées en onglets (barre de
// titre, cf. SettingsSubnav). Ce module ne fait que router — la carte des pages vit dans
// features/settings/nav, chaque panneau dans son propre fichier.
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { hasCacheAlert } from "@/store/storage";
import { SETTINGS_PAGES, hasSettingsTabs, settingsPageDef, type SettingsPage } from "@/features/settings/nav";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdobeBridgePanel } from "@/components/adobe/AdobeBridgePanel";
import { AccountSettings } from "./AccountSettings";
import { DiscordSettings } from "./DiscordSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { LanguageSettings } from "./LanguageSettings";
import { NavigationSettings } from "./NavigationSettings";
import { NotificationSettings } from "./NotificationSettings";
import { PlaybackSettings } from "./PlaybackSettings";
import { DictationSettings } from "./DictationSettings";
import { IndexingSettings } from "./IndexingSettings";
import { ModelsSettings } from "./models/ModelsSettings";
import { ExportProfileSettings } from "./ExportProfileSettings";
import { MediaCacheSection } from "./storage/MediaCacheSection";
import { CleanupSettings } from "./storage/CleanupSettings";
import { OutboxSettings } from "./OutboxSettings";
import { ProjectsSection } from "./storage/ProjectsSection";
import { UpdateSettings } from "./UpdateSettings";
import { CompatibilitySettings } from "./CompatibilitySettings";
import { ConsoleSettings } from "./ConsoleSettings";
import { AboutSettings } from "./AboutSettings";

const PANELS: Record<SettingsPage, Record<string, ComponentType>> = {
  account: { profile: AccountSettings, discord: DiscordSettings },
  interface: { theme: AppearanceSettings, language: LanguageSettings, navigation: NavigationSettings, notifications: NotificationSettings },
  media: { preview: PlaybackSettings },
  ai: { models: ModelsSettings, dictation: DictationSettings, indexing: IndexingSettings },
  export: { export: ExportProfileSettings },
  adobe: { adobe: AdobeBridgePanel },
  storage: { media: MediaCacheSection, cleanup: CleanupSettings, project: OutboxSettings, projects: ProjectsSection },
  system: { updates: UpdateSettings, compatibility: CompatibilitySettings, console: ConsoleSettings },
  about: { about: AboutSettings },
};

function SettingsNav() {
  const { t } = useTranslation("settings");
  const page = useApp((s) => s.settingsPage);
  const setPage = useApp((s) => s.setSettingsPage);
  const storageAlert = useApp(hasCacheAlert);

  return (
    <aside className="w-48 shrink-0 overflow-y-auto border-r border-border px-3 py-4">
      <h1 className="px-2 text-lg font-semibold tracking-tight">{t("title")}</h1>
      <nav className="mt-4 flex flex-col gap-0.5" aria-label={t("title")}>
        {SETTINGS_PAGES.map((item) => {
          const on = item.id === page;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => setPage(item.id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                on ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60",
              )}
            >
              <Icon className="size-4 shrink-0" /> {t(`nav.${item.id}`)}
              {item.id === "storage" && storageAlert && (
                <span className="ml-auto size-1.5 shrink-0 rounded-full bg-destructive" />
              )}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

/** Repli des onglets DANS la page : en mode épinglé la barre de titre masque sa sous-nav, sans ça on
 *  resterait coincé sur l'onglet courant. */
function InlineTabs({ page, tab }: { page: SettingsPage; tab: string }) {
  const { t } = useTranslation("settings");
  const setTab = useApp((s) => s.setSettingsTab);
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(page, value as string)}>
      <TabsList className="h-8">
        {settingsPageDef(page).tabs.map((item) => (
          <TabsTrigger key={item.id} value={item.id}>{t(`tab.${page}.${item.id}`)}</TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

export function SettingsPanel() {
  const { page, tab, pinned } = useApp(
    useShallow((s) => ({ page: s.settingsPage, tab: s.settingsTab[s.settingsPage], pinned: s.pinned })),
  );
  const def = settingsPageDef(page);
  const current = def.tabs.find((item) => item.id === tab) ?? def.tabs[0];
  const Panel = PANELS[page][current.id];

  return (
    <div className="flex h-full">
      <SettingsNav />

      <div className="flex-1 overflow-auto">
        {pinned && hasSettingsTabs(page) && <div className="px-7 pt-5"><InlineTabs page={page} tab={current.id} /></div>}
        {/* Le pont Adobe rend deux cartes de statut + un snapshot : pleine largeur, hors de la
            colonne de lecture des autres panneaux. */}
        {current.wide ? <Panel /> : <div className="p-7"><div className="mx-auto max-w-2xl"><Panel /></div></div>}
      </div>
    </div>
  );
}
