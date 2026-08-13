// Dialogue de partage du board au format .netsu : choix de CE QU'ON GARDE des vidéos.
//
// La question posée n'est pas « quel mode d'archive ? » mais « qu'est-ce que ce fichier emporte
// des vidéos ? ». Les quatre niveaux forment une ÉCHELLE, du plus léger au plus lourd, chacun avec
// son poids estimé en face — on choisit en voyant le prix, pas en devinant. Sémantique :
// core/netsu/levels.js.
//
// Deux règles de présentation, chacune corrigeant une confusion réelle :
// 1. Qualité et marge sont des RÉGLAGES du niveau choisi, pas des niveaux — ils vivent donc en
//    retrait SOUS la liste, jamais en rangées sœurs, où ils se lisaient comme deux options de plus.
// 2. Le poids total n'est écrit qu'UNE fois. La rangée sélectionnée le porte déjà ; le répéter en
//    pied laissait croire à deux nombres différents.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link2, Film, Maximize2, HardDrive, TriangleAlert } from "lucide-react";
import { nr, type NetsuLevel, type NetsuQuality, type NetsuExportOpts, type NetsuWeight } from "@/lib/bridge";
import { fmtBytes } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useBoard } from "./useReferenceBoard";
import { EMBED_LEVELS, EMBED_QUALITIES, EMBED_MARGINS } from "./referenceShared";

const LEVEL_ICONS: Record<NetsuLevel, typeof Link2> = {
  link: Link2,
  preview: Film,
  margin: Maximize2,
  full: HardDrive,
};
// Au-delà, on prévient : un fichier de cette taille ne se partage pas comme une pièce jointe.
const HEAVY_BYTES = 200 * 1024 * 1024;
// La pesée sonde les médias (ffprobe) : on attend que l'utilisateur ait fini de cliquer.
const WEIGH_DEBOUNCE_MS = 250;
const FREEZE_ID = "netsu-export-freeze";

/** Réglage subordonné au niveau choisi : libellé discret à gauche, contrôle segmenté à droite. */
function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function ExportDialog({
  open,
  onOpenChange,
  onExport,
  onWeigh,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onExport: (opts: NetsuExportOpts) => Promise<unknown>;
  onWeigh: (opts: NetsuExportOpts) => Promise<NetsuWeight>;
}) {
  const { t } = useTranslation("reference");
  const prefs = useBoard((s) => s.prefs);
  const [level, setLevel] = useState<NetsuLevel>(prefs.embedLevel);
  const [quality, setQuality] = useState<NetsuQuality>(prefs.embedQuality);
  const [marginSec, setMarginSec] = useState(prefs.embedMargin);
  const [freeze, setFreeze] = useState(false);
  const [busy, setBusy] = useState(false);
  const [weight, setWeight] = useState<NetsuWeight | null>(null);
  const [weighing, setWeighing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Rouvrir le dialogue repart des réglages du board : le choix d'un partage précédent ne doit pas
  // rester collé à l'écran suivant.
  useEffect(() => {
    if (!open) return;
    setLevel(prefs.embedLevel);
    setQuality(prefs.embedQuality);
    setMarginSec(prefs.embedMargin);
  }, [open, prefs.embedLevel, prefs.embedQuality, prefs.embedMargin]);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setWeighing(true);
    const timer = window.setTimeout(() => {
      void onWeigh({ level, quality, marginSec }).then((res) => {
        if (!alive) return;
        setWeight(res);
        setWeighing(false);
      });
    }, WEIGH_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [open, level, quality, marginSec, onWeigh]);

  // Le partage encode ses clips un par un : sans ce compte-rendu, un board fourni laisse
  // l'utilisateur devant un bouton figé sans savoir s'il reste dix items ou deux cents.
  useEffect(() => {
    if (!busy) return undefined;
    return nr.reference?.onShareProgress((p) => setProgress({ done: p.done, total: p.total }));
  }, [busy]);

  const run = useCallback(async () => {
    setBusy(true);
    setProgress(null);
    try {
      await onExport({ level, quality, marginSec, freezeLinks: freeze });
      onOpenChange(false);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [onExport, onOpenChange, level, quality, marginSec, freeze]);

  const perLevel = weight?.perLevel;
  const heavy = !!perLevel && perLevel[level] >= HEAVY_BYTES;
  const hasLong = !!weight?.items?.some((i) => i.long);
  const tuned = level === "preview" || level === "margin";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("export.title")}</DialogTitle>
          <DialogDescription>{t("export.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <ToggleGroup
            value={[level]}
            onValueChange={(v) => { const next = v[0] as NetsuLevel | undefined; if (next) setLevel(next); }}
            disabled={busy}
            spacing={0}
            variant="outline"
            className="grid w-full grid-cols-1"
          >
            {EMBED_LEVELS.map((id) => {
              const Icon = LEVEL_ICONS[id];
              const active = id === level;
              return (
                <ToggleGroupItem
                  key={id}
                  value={id}
                  className="h-auto items-start justify-start gap-3 px-3 py-2.5 text-left aria-pressed:bg-primary/10 aria-pressed:text-foreground aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-primary/60"
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium leading-tight">{t(`embed.level.${id}`)}</span>
                    <span className="mt-1 block text-xs leading-snug text-muted-foreground">{t(`embed.hint.${id}`)}</span>
                  </span>
                  <span
                    className={`shrink-0 text-xs tabular-nums ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}
                  >
                    {perLevel ? `~ ${fmtBytes(perLevel[id])}` : "—"}
                  </span>
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>

          {/* Retrait aligné sous le TITRE des niveaux (bordure + px-3 + icône + gap) : il dit que ces
              réglages appartiennent au niveau choisi, pas qu'ils en sont un de plus. */}
          {tuned && (
            <div className="flex flex-col gap-2 pl-9">
              <SettingRow label={t("embed.quality.label")}>
                <ToggleGroup
                  value={[quality]}
                  onValueChange={(v) => { const next = v[0] as NetsuQuality | undefined; if (next) setQuality(next); }}
                  disabled={busy}
                  spacing={0}
                  variant="outline"
                >
                  {EMBED_QUALITIES.map((q) => (
                    <ToggleGroupItem key={q} value={q} className="px-3 py-1.5 text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary">
                      {t(`embed.quality.${q}`)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </SettingRow>

              {level === "margin" && (
                <SettingRow label={t("embed.margin.label")}>
                  <ToggleGroup
                    value={[String(marginSec)]}
                    onValueChange={(v) => { const next = v[0]; if (next != null) setMarginSec(Number(next)); }}
                    disabled={busy}
                    spacing={0}
                    variant="outline"
                  >
                    {EMBED_MARGINS.map((m) => (
                      <ToggleGroupItem key={m} value={String(m)} className="px-3 py-1.5 text-xs tabular-nums aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary">
                        {t("embed.margin.seconds", { count: m })}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </SettingRow>
              )}
            </div>
          )}

          {/* Case à cocher plutôt que bouton pressé : elle dit son état sans dépendre d'un fond. */}
          <div className="flex items-start gap-2.5">
            <Checkbox
              id={FREEZE_ID}
              checked={freeze}
              onCheckedChange={(next) => setFreeze(next === true)}
              disabled={busy}
              className="mt-0.5"
            />
            <div className="min-w-0">
              <Label htmlFor={FREEZE_ID} className="text-sm font-normal">{t("export.freezeLinks")}</Label>
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{t("export.freezeHint")}</p>
            </div>
          </div>

          {(heavy || hasLong) && (
            <p className="flex items-start gap-2 text-xs leading-snug text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
              <span>{heavy ? t("embed.warn.heavy", { size: fmtBytes(perLevel![level]) }) : t("embed.warn.long")}</span>
            </p>
          )}
        </div>

        <DialogFooter className="items-center">
          <p className="mr-auto flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
            {busy && progress ? (
              <>
                <Spinner className="size-3" />
                {t("export.progress", { done: progress.done, total: progress.total })}
              </>
            ) : weighing ? (
              <>
                <Spinner className="size-3" />
                {t("export.weighing")}
              </>
            ) : null}
          </p>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t("common:action.cancel")}</Button>
          <Button onClick={() => void run()} disabled={busy}>{busy ? t("export.exporting") : t("export.export")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
