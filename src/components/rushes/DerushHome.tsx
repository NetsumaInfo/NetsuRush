import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, FileVideo, Scissors, Settings2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useApp } from "@/store";
import { nr } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { CutSettings } from "./CutSettings";

export function DerushHome() {
  const { t } = useTranslation("derush");
  const { enterMediaPool, importFiles, activeHost, connected, openCutTimeline, libraryError } = useApp(
    useShallow((s) => ({ enterMediaPool: s.enterMediaPool, importFiles: s.importFiles, activeHost: s.activeHost, connected: s.connected, openCutTimeline: s.openCutTimeline, libraryError: s.libraryError })),
  );
  const adobeActive = activeHost !== "resolve";
  const hostName = activeHost === "ppro" ? "Premiere Pro" : activeHost === "aeft" ? "After Effects" : "Resolve";
  // Hôte fermé, la carte ne peut pas promettre les rush d'un projet : elle mène au navigateur, qui
  // montre désormais la bibliothèque. Même carte, même action — seul le texte cesse de mentir.
  const poolLabel = !connected ? t("home.browseMedia") : adobeActive ? t("home.openProject") : t("home.openPool");
  const poolHint = !connected ? t("home.browseMediaHint") : adobeActive ? t("home.poolHintHost", { host: hostName }) : t("home.poolHintResolve");
  const [settings, setSettings] = useState(false);

  // Import DIRECT dans la bibliothèque : plus de dialogue « Media Pool ou derush direct ». Les rushs
  // atterrissent à la racine « Importés » et y restent d'une session à l'autre.
  async function pickFiles() {
    const paths = await nr.chooseFiles();
    if (paths && paths.length) void importFiles(paths);
  }

  return (
    // `relative` : le panneau Paramètres se pose en absolu dans ce cadre (haut-droite).
    <div className="relative mx-auto max-w-3xl space-y-4 px-4 py-7 sm:space-y-6 sm:px-6 sm:py-9 lg:px-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{t("home.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("home.subtitle")}
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger render={
            <Button variant="ghost" size="icon-sm" aria-label={t("settings.title")} onClick={() => setSettings((v) => !v)} />
          }>
            <Settings2 className="size-4" />
          </TooltipTrigger>
          <TooltipContent>{t("settings.title")}</TooltipContent>
        </Tooltip>
      </div>
      <CutSettings open={settings} onOpenChange={setSettings} />

      {libraryError && <p className="text-sm text-destructive">{libraryError}</p>}

      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <button type="button" onClick={enterMediaPool}
            className="group flex flex-row items-center gap-4 rounded-xl bg-card p-4 text-left shadow-xs ring-1 ring-foreground/10 outline-none transition-all hover:-translate-y-0.5 hover:ring-primary/60 focus-visible:ring-2 focus-visible:ring-ring sm:flex-col sm:items-start sm:gap-3 sm:p-6">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
              <FolderOpen className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="font-medium">{poolLabel}</div>
              <p className="mt-1 text-sm text-muted-foreground">
                {poolHint}
              </p>
            </div>
          </button>

          <button type="button" onClick={pickFiles}
            className="group flex flex-row items-center gap-4 rounded-xl bg-card p-4 text-left shadow-xs ring-1 ring-foreground/10 outline-none transition-all hover:-translate-y-0.5 hover:ring-primary/60 focus-visible:ring-2 focus-visible:ring-ring sm:flex-col sm:items-start sm:gap-3 sm:p-6">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
              <FileVideo className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="font-medium">{t("home.import")}</div>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("home.importHint")}
              </p>
            </div>
          </button>
        </div>
          {/* Découpe d'une timeline entière : flux natif Resolve, ou — sur hôte Adobe — détection sur
              les rushs de la séquence du snapshot puis montage par le job du panneau (hostCutTimeline). */}
          <button type="button" onClick={openCutTimeline}
            className="group flex w-full items-center gap-4 rounded-xl bg-card p-4 text-left sm:p-5 shadow-xs ring-1 ring-foreground/10 outline-none transition-all hover:-translate-y-0.5 hover:ring-primary/60 focus-visible:ring-2 focus-visible:ring-ring">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
              <Scissors className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="font-medium">{t("home.cutTimeline")}</div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {t("home.cutTimelineHint")}
              </p>
            </div>
          </button>
        </div>
    </div>
  );
}
