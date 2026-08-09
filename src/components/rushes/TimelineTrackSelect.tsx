// Sélecteur de piste de Timeline Live : « Toutes les pistes » puis une entrée par piste vidéo, sous
// son nom EXACT chez l'hôte (« Vidéo 1 », « B-roll »…). Un tiroir plutôt qu'un groupe segmenté :
// une timeline porte couramment cinq à dix pistes, et des noms complets ne tiennent pas sur une
// bande — surtout dans le panneau CEP, large de 560 px.
import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TrackOption } from "./timelineTracks";

const ALL = "all";

export function TimelineTrackSelect({ options, value, onChange, total }: {
  options: TrackOption[];
  value: number | null;               // null = toutes les pistes
  onChange: (track: number | null) => void;
  total: number;                      // plans de la timeline, toutes pistes confondues
}) {
  const { t } = useTranslation("derush");
  // L'hôte ne donne pas toujours de nom : panneau CEP antérieur à ce champ, ou plans relus du cache
  // projet hors ligne. La piste garde alors son rang, seule chose qu'on sache d'elle.
  const label = (option: TrackOption) => option.name || t("timelineLive.trackFallback", { index: option.index });
  const current = options.find((option) => option.index === value) ?? null;

  // Une seule piste : le tiroir n'offrirait aucun choix (cas d'une comp After Effects, qui n'a pas
  // de pistes du tout). On ne montre pas un sélecteur inerte.
  if (options.length < 2) return null;

  return (
    <Select value={current ? String(current.index) : ALL}
      onValueChange={(v) => onChange(v === ALL ? null : Number(v))}>
      {/* Sans pictogramme : les icônes de calques et de pellicule désignent déjà d'autres objets
          dans l'application, et une piste de montage n'a pas de symbole à elle. */}
      <SelectTrigger size="sm" className="h-8 w-auto min-w-40 max-w-56 gap-1.5" aria-label={t("timelineLive.tracks")}>
        <SelectValue className="min-w-0 flex-1 truncate">
          {current ? label(current) : t("timelineLive.allTracks")}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>
          <Row label={t("timelineLive.allTracks")} count={total} />
        </SelectItem>
        {options.map((option) => (
          <SelectItem key={option.index} value={String(option.index)}>
            <Row label={label(option)} count={option.count} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Le compte vit à droite de chaque entrée : sans lui, choisir une piste revient à ouvrir une grille
// dont on ne sait pas si elle porte trois plans ou six cents.
function Row({ label, count }: { label: string; count: number }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>
    </span>
  );
}
