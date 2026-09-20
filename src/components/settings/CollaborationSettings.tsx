import { useState } from "react";
import { useTranslation } from "react-i18next";
import { COLLAB_SURFACES, setCollabPreferences, useCollabPreferences, type CollabProfile, type CollabPreferences } from "@/lib/collab/preferences";
import { CompactSelect, SettingRow } from "./rows";

export function CollaborationSettings() {
  const { t } = useTranslation("settings");
  const preferences = useCollabPreferences();
  const [failed, setFailed] = useState(false);
  const profiles = (["live", "balanced", "economy"] as const).map((value) => ({ value, label: t(`collaboration.profiles.${value}`) }));
  function save(next: CollabPreferences) {
    try { setCollabPreferences(next); setFailed(false); }
    catch { setFailed(true); }
  }
  return <section>
    <h2 className="text-sm font-medium">{t("collaboration.title")}</h2>
    <p className="mt-1 text-xs text-muted-foreground">{t("collaboration.description")}</p>
    <p className="mt-2 text-xs text-muted-foreground">{t("collaboration.profilesHint")}</p>
    <div className="mt-4 divide-y divide-border rounded-lg border border-border">
      <SettingRow label={t("collaboration.default")}>
        <CompactSelect value={preferences.profile} choices={profiles} onChange={(profile) => save({ ...preferences, profile })} />
      </SettingRow>
      {COLLAB_SURFACES.map((surface) => <SettingRow key={surface} label={t(`collaboration.surfaces.${surface}`)}>
        <CompactSelect<CollabProfile | "inherit"> value={preferences.overrides[surface] ?? "inherit"}
          choices={[{ value: "inherit", label: t("collaboration.inherit") }, ...profiles]}
          onChange={(profile) => {
            const overrides = { ...preferences.overrides };
            if (profile === "inherit") delete overrides[surface];
            else overrides[surface] = profile;
            save({ ...preferences, overrides });
          }} />
      </SettingRow>)}
    </div>
    {failed && <p className="mt-2 text-xs text-destructive" role="alert">{t("collaboration.saveFailed")}</p>}
  </section>;
}
