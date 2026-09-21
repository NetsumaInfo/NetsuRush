// Ce que l'app dit d'elle-même, et combien de temps. Deux blocs :
//   • les durées d'affichage des retours d'état — elle confirme, elle signale une erreur, elle
//     compte les erreurs journalisées. La pastille d'une tâche EN COURS n'est pas réglable : elle vit
//     tant que la tâche dure, c'est son achèvement qui la remplace ;
//   • l'invite qui propose de fermer le logiciel de montage pendant une tâche lourde, puis de le
//     rouvrir. Rien ici ne retire une capacité : fermer et rouvrir restent dans le menu du voyant de
//     la barre latérale, quoi qu'on coupe.
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { NOTIFY_CHOICES, type NotifyDurations } from "@/lib/notifySettings";
import type { PowerPromptSettings } from "@/lib/powerSettings";
import { CompactSelect, SectionTitle, SettingRow, type Choice } from "./rows";

export function NotificationSettings() {
  const { t } = useTranslation("settings");
  const notify = useApp((s) => s.notify);
  const setNotify = useApp((s) => s.setNotify);
  const resetNotify = useApp((s) => s.resetNotify);
  const power = useApp((s) => s.powerPrompt);
  const setPower = useApp((s) => s.setPowerPrompt);
  const resetPower = useApp((s) => s.resetPowerPrompt);

  const choices: Choice<number>[] = NOTIFY_CHOICES.map((seconds) => ({
    value: seconds,
    label: seconds === 0 ? t("notifications.untilClick") : t("notifications.seconds", { count: seconds }),
  }));
  const row = (key: keyof NotifyDurations) => (
    <CompactSelect value={notify[key]} choices={choices} onChange={(seconds) => setNotify({ [key]: seconds })} />
  );
  const toggle = (key: keyof PowerPromptSettings) => (
    <Toggle className="ml-auto flex" pressed={power[key]} onPressedChange={(value) => setPower({ [key]: value })}>
      {power[key] ? t("power.on") : t("power.off")}
    </Toggle>
  );

  return (
    <section className="flex flex-col gap-7">
      <header className="flex items-center justify-between gap-4">
        <SectionTitle title={t("notifications.title")} info={t("notifications.subtitle")} />
        <Button variant="outline" size="sm" onClick={() => { resetNotify(); resetPower(); }}>
          <RotateCcw className="size-3.5" /> {t("notifications.reset")}
        </Button>
      </header>

      <div className="divide-y divide-border rounded-lg border border-border">
        <SettingRow label={t("notifications.ok")} hint={t("notifications.okHint")}>{row("ok")}</SettingRow>
        <SettingRow label={t("notifications.error")} hint={t("notifications.errorHint")}>{row("error")}</SettingRow>
        <SettingRow label={t("notifications.badge")} hint={t("notifications.badgeHint")}>{row("badge")}</SettingRow>
      </div>

      <div>
        <SectionTitle as="h3" title={t("power.title")} info={t("power.subtitle")} />
        <div className="mt-2 divide-y divide-border rounded-lg border border-border">
          <SettingRow label={t("power.offer")}>{toggle("offer")}</SettingRow>
          <SettingRow label={t("power.reopen")}>{toggle("reopen")}</SettingRow>
          <SettingRow label={t("power.nub")}>{toggle("nub")}</SettingRow>
        </div>
      </div>
    </section>
  );
}
