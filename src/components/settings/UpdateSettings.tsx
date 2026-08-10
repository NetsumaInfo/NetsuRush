import { Download, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUpdater } from "@/store/updater";
import { UpdateStatusLine } from "@/components/updates/UpdateStatusLine";
import { ErrorReportButton } from "@/components/common/ErrorReportButton";
import releases from "@/data/releases.json";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Toggle } from "@/components/ui/toggle";

export function UpdateSettings() {
  const { t, i18n } = useTranslation("settings");
  const phase = useUpdater((state) => state.phase);
  const info = useUpdater((state) => state.info);
  const progress = useUpdater((state) => state.progress);
  const error = useUpdater((state) => state.error);
  const autoCheck = useUpdater((state) => state.autoCheck);
  const setAutoCheck = useUpdater((state) => state.setAutoCheck);
  const check = useUpdater((state) => state.check);
  const download = useUpdater((state) => state.download);
  const install = useUpdater((state) => state.install);
  const language = i18n.language.startsWith("fr") ? "fr" : "en";
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  // Même pourcentage exact que dans la barre de titre : une décimale, jamais d'arrondi à l'entier.
  const percent = progress == null
    ? null
    : new Intl.NumberFormat(i18n.language, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 })
        .format(Math.min(100, progress) / 100);

  return (
    <section className="flex flex-col gap-5">
      <header>
        <h2 className="text-sm font-medium">{t("updates.title")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("updates.subtitle")}</p>
      </header>

      <Card className="gap-4 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">{t("updates.auto")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("updates.autoHint")}</p>
          </div>
          <Toggle pressed={autoCheck} onPressedChange={setAutoCheck} aria-label={t("updates.auto")}>
            {autoCheck ? t("updates.on") : t("updates.off")}
          </Toggle>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <UpdateStatusLine phase={phase} info={info} />
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={busy || phase === "downloaded"} onClick={() => void check()}>
              <RefreshCw className={phase === "checking" ? "size-3.5 animate-spin" : "size-3.5"} /> {t("updates.check")}
            </Button>
            {phase === "available" && <Button size="sm" onClick={() => void download()}><Download className="size-3.5" /> {t("updates.download")}</Button>}
            {/* Téléchargement terminé : l'action restante n'est plus « installer » mais « redémarrer ».
                Le dire évite de cliquer sans savoir que l'application va se fermer. */}
            {phase === "downloaded" && <Button size="sm" onClick={() => void install()}><RefreshCw className="size-3.5" /> {t("updates.restart")}</Button>}
            {phase === "installing" && <Button size="sm" disabled><Loader2 className="size-3.5 animate-spin" /> {t("updates.installing")}</Button>}
          </div>
        </div>
        {(phase === "downloading" || phase === "downloaded") && (
          <div className="flex items-center gap-3">
            <Progress className="min-w-0 flex-1" value={progress} />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{percent}</span>
          </div>
        )}
        {error && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 break-words text-xs text-destructive">{error}</p>
            <ErrorReportButton
              error={error}
              subject={`Échec de la mise à jour${info?.version ? ` vers la v${info.version}` : ""}`}
              module="settings"
              moduleLabel="Paramètres"
            />
          </div>
        )}
        {info?.body && <p className="whitespace-pre-line text-xs text-muted-foreground">{info.body}</p>}
      </Card>

      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{t("updates.history")}</h3>
        <div className="mt-2 flex flex-col gap-2">
          {releases.map((release) => (
            <Card key={release.id} className="gap-2 p-4">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{release.title[language]}</p>
                <Badge variant="outline">v{release.version}</Badge>
                <span className="ml-auto text-xs text-muted-foreground">{release.date}</span>
              </div>
              <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                {release.highlights[language].map((highlight) => <li key={highlight}>{highlight}</li>)}
              </ul>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

