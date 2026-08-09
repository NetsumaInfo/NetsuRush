// Sélecteur du profil appliqué par le petit bouton de chaque vignette (« télécharger » direct).
// Réutilisé dans le panneau rapide et dans les Paramètres › Export.
import { useApp } from "@/store";
import { useTranslation } from "react-i18next";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { getActiveExportProfile } from "@/features/export/profiles";

export function CardActionPicker({ className }: { className?: string }) {
  const { t } = useTranslation("export");
  const profiles = useApp((s) => s.exportProfiles);
  const cardId = useApp((s) => s.cardActionProfileId);
  const setCard = useApp((s) => s.setCardActionProfile);
  const card = getActiveExportProfile(profiles, cardId);
  const items = profiles.map((p) => ({ value: p.id, label: p.name }));

  return (
    <Select value={card.id} onValueChange={(v) => setCard(v as string)} items={items}>
      <SelectTrigger className={className} aria-label={t("settings.cardButton")}><SelectValue>{card.name}</SelectValue></SelectTrigger>
      <SelectContent>
        {profiles.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
