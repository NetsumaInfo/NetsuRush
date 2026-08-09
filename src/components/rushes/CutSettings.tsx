// Panneau Paramètres de NetsuCut (engrenage de l'accueil du module) : défauts de détection, aperçu
// et son, grille/lecteur, export, et les raccourcis clavier.
//
// NON-MODAL (panneau flottant, sans voile), comme les Paramètres du board : l'accueil reste visible.
// Fermeture : croix ou Échap — sauf pendant la capture d'un raccourci, où Échap annule la capture.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Minus, Plus } from "lucide-react";
import { useApp } from "@/store";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import { VolumeSlider } from "@/components/player/VolumeSlider";
import { ShortcutEditor } from "@/components/shortcuts/ShortcutEditor";
import { CUT_SHORTCUT_DEFS } from "./cutShortcuts";
import { modelUsesPreset } from "@/lib/detection";
import { DetectionAdvancedSettings } from "./DetectionAdvancedSettings";
import { DetectionModelSelect, DetectionPresetSelect } from "./DetectionControls";
import { SORT_KEYS, SORT_LABEL_KEYS, loadSortKey, saveSortKey, type SortKey } from "./rushSort";

type CutTab = "detect" | "preview" | "grid" | "export" | "keys";
const TABS: { id: CutTab; labelKey: string }[] = [
  { id: "detect", labelKey: "settings.tabDetect" },
  { id: "preview", labelKey: "settings.tabPreview" },
  { id: "grid", labelKey: "settings.tabGrid" },
  { id: "export", labelKey: "settings.tabExport" },
  { id: "keys", labelKey: "settings.tabKeys" },
];

// Bouton segment (choix exclusif) à la DA shadcn. Bordure TOUJOURS présente (transparente si active)
// → la largeur ne bouge pas au clic.
function Seg({ active, onClick, disabled, children }: {
  active: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40",
        active ? "border-transparent bg-primary text-primary-foreground" : "border-border bg-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-foreground">{label}</h3>
      {hint && <p className="-mt-1 text-[11px] text-muted-foreground">{hint}</p>}
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </section>
  );
}

export function CutSettings({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation(["derush", "common"]);
  const [tab, setTab] = useState<CutTab>("detect");
  const [capturing, setCapturing] = useState(false);
  // Le tri des rushs vit dans son module (rushSort) et se lit à l'init de RushGrid → miroir local ici.
  const [sortKey, setSortKey] = useState<SortKey>(loadSortKey);

  const cutModel = useApp((s) => s.cutModel);
  const setCutModel = useApp((s) => s.setCutModel);
  const cutPreset = useApp((s) => s.cutPreset);
  const setCutPreset = useApp((s) => s.setCutPreset);
  const cutGridPlay = useApp((s) => s.cutGridPlay);
  const setCutGridPlay = useApp((s) => s.setCutGridPlay);
  const cutCols = useApp((s) => s.cutCols);
  const setCutCols = useApp((s) => s.setCutCols);
  const cutPlayerOpen = useApp((s) => s.cutPlayerOpen);
  const setCutPlayerOpen = useApp((s) => s.setCutPlayerOpen);
  const hoverVolume = useApp((s) => s.hoverVolume);
  const setHoverVolume = useApp((s) => s.setHoverVolume);
  const hoverMuted = useApp((s) => s.hoverMuted);
  const setHoverMuted = useApp((s) => s.setHoverMuted);
  const playerVolume = useApp((s) => s.playerVolume);
  const setPlayerVolume = useApp((s) => s.setPlayerVolume);
  const cutKeys = useApp((s) => s.cutKeys);
  const setCutKeys = useApp((s) => s.setCutKeys);
  const resetCutKeys = useApp((s) => s.resetCutKeys);
  const exportProfiles = useApp((s) => s.exportProfiles);
  const activeExportProfileId = useApp((s) => s.activeExportProfileId);
  const setActiveExportProfile = useApp((s) => s.setActiveExportProfile);
  const cardActionProfileId = useApp((s) => s.cardActionProfileId);
  const setCardActionProfile = useApp((s) => s.setCardActionProfile);

  // Échap ferme — mais pendant la capture d'un raccourci il annule la capture (géré par
  // ShortcutEditor) et ne doit PAS fermer le panneau d'un coup.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !capturing) { e.stopPropagation(); onOpenChange(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onOpenChange, capturing]);

  if (!open) return null;

  const presetModel = modelUsesPreset(cutModel);

  return (
    <div
      role="dialog"
      aria-label={t("settings.title")}
      className="absolute right-3 top-14 z-50 flex max-h-[calc(100%-4.5rem)] w-96 flex-col overflow-y-auto rounded-xl border border-border bg-card/95 shadow-2xl backdrop-blur"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{t("settings.title")}</h2>
        <button
          type="button"
          aria-label={t("common:action.close")}
          onClick={() => onOpenChange(false)}
          className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        {TABS.map((tb) => (
          <Seg key={tb.id} active={tab === tb.id} onClick={() => setTab(tb.id)}>{t(tb.labelKey)}</Seg>
        ))}
      </div>

      <div className="flex flex-col gap-5 p-4">
        {tab === "detect" && (<>
          <Row label={t("settings.defaultModel")} hint={t("settings.defaultModelHint")}>
            <DetectionModelSelect model={cutModel} onChange={setCutModel} className="w-40" />
            <DetectionAdvancedSettings model={cutModel} compact />
          </Row>
          {presetModel && (<>
            <Separator />
            <Row label={t("settings.defaultPreset")} hint={t("settings.defaultPresetHint")}>
              <DetectionPresetSelect model={cutModel} preset={cutPreset} onChange={setCutPreset} className="w-36" />
            </Row>
          </>)}
        </>)}

        {tab === "preview" && (<>
          <Row label={t("settings.autoplay")} hint={t("settings.autoplayHint")}>
            <Toggle
              size="sm"
              variant="outline"
              pressed={cutGridPlay}
              onPressedChange={setCutGridPlay}
              className="text-xs text-muted-foreground aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary"
            >
              {cutGridPlay ? t("settings.on") : t("settings.off")}
            </Toggle>
          </Row>
          <Separator />
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold text-foreground">{t("settings.hoverVolume")}</h3>
            <p className="-mt-1 text-[11px] text-muted-foreground">{t("settings.hoverVolumeHint")}</p>
            <div className="rounded-md bg-input/30 px-3 py-1">
              <VolumeSlider value={hoverVolume} onChange={setHoverVolume} muted={hoverMuted} onMutedChange={setHoverMuted} showValue />
            </div>
            {/* Volume des lecteurs à 0 = muet global : le curseur de survol reste réglable, mais il ne
                produira rien tant que le son global est coupé — on le dit au lieu de laisser croire
                à un réglage cassé. */}
            {playerVolume === 0 && <p className="-mt-1 text-[11px] text-muted-foreground">{t("settings.hoverVolumeGlobalMuted")}</p>}
          </section>
          <Separator />
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold text-foreground">{t("settings.playerVolume")}</h3>
            <p className="-mt-1 text-[11px] text-muted-foreground">{t("settings.playerVolumeHint")}</p>
            <div className="rounded-md bg-input/30 px-3 py-1">
              <VolumeSlider value={playerVolume} onChange={setPlayerVolume} showValue />
            </div>
          </section>
        </>)}

        {tab === "grid" && (<>
          <Row label={t("settings.density")} hint={t("settings.densityHint")}>
            <div className="flex h-7 items-center gap-0.5 rounded-md border border-border bg-card px-1 text-xs">
              <button type="button" onClick={() => setCutCols(cutCols - 1)} disabled={cutCols <= 2} aria-label={t("settings.smaller")} className="flex size-6 items-center justify-center rounded transition-colors hover:bg-accent disabled:opacity-40"><Minus className="size-3.5" /></button>
              <span className="w-4 text-center tabular-nums">{cutCols}</span>
              <button type="button" onClick={() => setCutCols(cutCols + 1)} disabled={cutCols >= 8} aria-label={t("settings.bigger")} className="flex size-6 items-center justify-center rounded transition-colors hover:bg-accent disabled:opacity-40"><Plus className="size-3.5" /></button>
            </div>
          </Row>
          <Separator />
          <Row label={t("settings.playerOpen")} hint={t("settings.playerOpenHint")}>
            <Seg active={cutPlayerOpen} onClick={() => setCutPlayerOpen(true)}>{t("settings.shown")}</Seg>
            <Seg active={!cutPlayerOpen} onClick={() => setCutPlayerOpen(false)}>{t("settings.hidden")}</Seg>
          </Row>
          <Separator />
          <Row label={t("settings.rushSort")} hint={t("settings.rushSortHint")}>
            {SORT_KEYS.map((k) => (
              <Seg key={k} active={sortKey === k} onClick={() => { setSortKey(k); saveSortKey(k); }}>{t(SORT_LABEL_KEYS[k])}</Seg>
            ))}
          </Row>
        </>)}

        {tab === "export" && (<>
          <Row label={t("settings.exportProfile")} hint={t("settings.exportProfileHint")}>
            {exportProfiles.map((p) => (
              <Seg key={p.id} active={activeExportProfileId === p.id} onClick={() => setActiveExportProfile(p.id)}>{p.name}</Seg>
            ))}
          </Row>
          <Separator />
          <Row label={t("settings.cardProfile")} hint={t("settings.cardProfileHint")}>
            {exportProfiles.map((p) => (
              <Seg key={p.id} active={cardActionProfileId === p.id} onClick={() => setCardActionProfile(p.id)}>{p.name}</Seg>
            ))}
          </Row>
        </>)}

        {tab === "keys" && (
          <ShortcutEditor
            defs={CUT_SHORTCUT_DEFS}
            keys={cutKeys}
            onChange={setCutKeys}
            onReset={resetCutKeys}
            title={t("settings.shortcutsSection")}
            onCapturingChange={setCapturing}
          />
        )}
      </div>
    </div>
  );
}
