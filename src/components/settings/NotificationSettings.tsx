// Durées d'affichage des retours d'état. Trois réglages seulement, parce qu'il n'y a que trois
// façons dont l'app parle : elle confirme, elle signale une erreur, elle compte les erreurs
// journalisées. La pastille d'une tâche EN COURS n'est pas réglable — elle vit tant que la tâche
// dure, c'est son achèvement qui la remplace.
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { NOTIFY_CHOICES, type NotifyDurations } from "@/lib/notifySettings";
import { CompactSelect, SettingRow, type Choice } from "./rows";

export function NotificationSettings() {
  const { t } = useTranslation("settings");
  const notify = useApp((s) => s.notify);
  const setNotify = useApp((s) => s.setNotify);
  const resetNotify = useApp((s) => s.resetNotify);

  const choices: Choice<number>[] = NOTIFY_CHOICES.map((seconds) => ({
    value: seconds,
    label: seconds === 0 ? t("notifications.untilClick") : t("notifications.seconds", { count: seconds }),
  }));
  const row = (key: keyof NotifyDurations) => (
    <CompactSelect value={notify[key]} choices={choices} onChange={(seconds) => setNotify({ [key]: seconds })} />
  );

  return (
    <section className="flex flex-col gap-7">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium">{t("notifications.title")}</h2>
          <p className="mt-1 max-w-[68ch] text-xs text-muted-foreground">{t("notifications.subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={resetNotify}>
          <RotateCcw className="size-3.5" /> {t("notifications.reset")}
        </Button>
      </header>

      <div className="divide-y divide-border rounded-lg border border-border">
        <SettingRow label={t("notifications.ok")} hint={t("notifications.okHint")}>{row("ok")}</SettingRow>
        <SettingRow label={t("notifications.error")} hint={t("notifications.errorHint")}>{row("error")}</SettingRow>
        <SettingRow label={t("notifications.badge")} hint={t("notifications.badgeHint")}>{row("badge")}</SettingRow>
      </div>
    </section>
  );
}
