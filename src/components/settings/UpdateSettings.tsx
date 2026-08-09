import { Download, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUpdater } from "@/store/updater";
import { UpdateStatusLine } from "@/components/updates/UpdateStatusLine";
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
  const install = useUpdater((state) => state.install);
  const language = i18n.language.startsWith("fr") ? "fr" : "en";

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
            <Button variant="outline" size="sm" disabled={phase === "checking" || phase === "downloading"} onClick={() => void check()}>
              <RefreshCw className={phase === "checking" ? "size-3.5 animate-spin" : "size-3.5"} /> {t("updates.check")}
            </Button>
            {phase === "available" && <Button size="sm" onClick={() => void install()}><Download className="size-3.5" /> {t("updates.install")}</Button>}
          </div>
        </div>
        {phase === "downloading" && <Progress value={progress} />}
        {error && <p className="break-words text-xs text-destructive">{error}</p>}
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

