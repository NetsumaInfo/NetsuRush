import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { SendToTimelineIcon } from "@/components/common/SendToTimelineIcon";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
  ContextMenuSeparator, ContextMenuLabel, ContextMenuCheckboxItem, ContextMenuGroup,
  ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
} from "@/components/ui/context-menu";
import { canFewerCols, canMoreCols, MODELS, PRESETS, stepCols } from "./cutStudioShared";
import type { DetectModel } from "@/lib/bridge";
import { modelUsesPreset } from "@/lib/detection";

// Toutes les actions du studio de découpe regroupées en un clic droit (sur toute la colonne grille).
// En mode compact (fenêtre épinglée) il porte aussi les réglages de détection, dont l'entête est
// masqué faute de place ; la barre d'outils, elle, reste entière.
export interface CutMenuProps {
  children: ReactNode;
  segmentsCount: number;
  selCount: number;
  allSelected: boolean;
  detecting: boolean;
  busy: boolean;
  model: DetectModel;
  setModel: (m: DetectModel) => void;
  preset: number;
  setPreset: (i: number) => void;
  onDetect: () => void;
  onSelectAll: () => void;
  onDeselect: () => void;
  onMerge: () => void;
  hasEdits: boolean;
  onClearEdits: () => void;
  gridPlay: boolean;
  setGridPlay: (p: boolean) => void;
  /** Colonnes RÉELLEMENT affichées (cf. gridMetrics), pas le réglage mémorisé : c'est ce nombre
   *  que les deux entrées font varier, sinon les premiers clics ne changent rien à l'écran. */
  cols: number;
  /** Colonnes maximales que la largeur courante peut tenir sans passer sous le plancher de cellule. */
  maxCols: number;
  setCols: React.Dispatch<React.SetStateAction<number>>;
  onThumbs: () => void;
  thumbsBusy: boolean;
  onProxies: () => void;
  proxyBusy: boolean;
  connected: boolean;
  isLocal: boolean;
  onExtract: () => void;
  onCreateTimeline: () => void;
  onAppendSelection: () => void;
  exportedCount: number;
  onImportBack: () => void;
  compact: boolean;
  playerOpen: boolean;
  setPlayerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onClose: () => void;
}

export function CutContextMenu(p: CutMenuProps) {
  const { t } = useTranslation("derush");
  const has = p.segmentsCount > 0;
  const verb = p.selCount ? `(${p.selCount})` : t("shared.all");
  const canTimeline = p.connected && !p.isLocal;

  return (
    <ContextMenu>
      {/* min-h-0 : en colonne (vue étroite / fenêtre épinglée) la hauteur auto de cette colonne vaut
          celle de TOUTES les vignettes → elle débordait, la page entière défilait et la barre
          d'outils partait vers le haut. Bornée, seule la grille interne défile. */}
      <ContextMenuTrigger render={<div className="flex min-h-0 min-w-0 flex-1 flex-col pr-1" />}>
        {p.children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        <ContextMenuItem onClick={p.onClose}><NetsuIcon name="back" /> {t("cutMenu.backToRushes")}</ContextMenuItem>
        <ContextMenuSeparator />

        {/* Détection */}
        <ContextMenuItem onClick={p.onDetect} disabled={p.detecting}>
          <NetsuIcon name="cut-detect" busy={p.detecting} /> {p.detecting ? t("shared.analyzing") : t("shared.detectShots")}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={p.detecting}>{t("cutMenu.model",{ label: MODELS.find((m) => m.id === p.model)?.label })}</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {MODELS.map((m) => (
              <ContextMenuCheckboxItem key={m.id} checked={p.model === m.id} onClick={() => p.setModel(m.id)}>
                {m.label}
              </ContextMenuCheckboxItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        {modelUsesPreset(p.model) && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>{t("cutMenu.precision", { label: PRESETS[p.preset] ? t(PRESETS[p.preset].labelKey) : "" })}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {PRESETS.map((pr, i) => (
                <ContextMenuCheckboxItem key={pr.labelKey} checked={p.preset === i} onClick={() => p.setPreset(i)}>
                  {t(pr.labelKey)}
                </ContextMenuCheckboxItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}

        {has && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={p.onSelectAll}>
              <NetsuIcon name="cut-select" on={p.allSelected} /> {p.allSelected ? t("shared.deselectAll") : t("shared.selectAll")}
            </ContextMenuItem>
            {p.selCount > 0 && <ContextMenuItem onClick={p.onDeselect}>{t("cutMenu.clearSelection")}</ContextMenuItem>}
            {p.selCount >= 2 && <ContextMenuItem onClick={p.onMerge}><NetsuIcon name="cut-merge" /> {t("cutMenu.merge", { count: p.selCount })}</ContextMenuItem>}
            {p.hasEdits && <ContextMenuItem onClick={p.onClearEdits}><NetsuIcon name="split" /> {t("cutMenu.clearEdits")}</ContextMenuItem>}

            <ContextMenuSeparator />
            {/* Timeline : action principale du mode épinglé */}
            {canTimeline && (
              <ContextMenuItem onClick={p.onAppendSelection} disabled={p.busy || p.selCount === 0}>
                <SendToTimelineIcon /> {t("cutMenu.sendToTimeline", { verb })}
              </ContextMenuItem>
            )}
            {canTimeline && (
              <ContextMenuItem onClick={p.onCreateTimeline} disabled={p.busy || p.selCount === 0}>
                <SendToTimelineIcon /> {t("cutMenu.createTimeline", { verb })}
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={p.onExtract} disabled={p.busy || p.selCount === 0}><NetsuIcon name="scissors" /> {t("cutMenu.extract", { verb })}</ContextMenuItem>
            {p.connected && p.exportedCount > 0 && (
              <ContextMenuItem onClick={p.onImportBack} disabled={p.busy}><NetsuIcon name="cut-import" /> {t("cutMenu.importExtracts")}</ContextMenuItem>
            )}

            <ContextMenuSeparator />
            {/* Aperçus */}
            <ContextMenuCheckboxItem checked={p.gridPlay} onClick={() => p.setGridPlay(!p.gridPlay)}>
              <NetsuIcon name="play" /> {t("shared.autoplay")}
            </ContextMenuCheckboxItem>
            <ContextMenuItem onClick={p.onThumbs}><NetsuIcon name="image" /> {p.thumbsBusy ? t("shared.stopThumbs") : t("shared.genThumbs", { verb })}</ContextMenuItem>
            <ContextMenuItem onClick={p.onProxies}><NetsuIcon name="zap" /> {p.proxyBusy ? t("shared.stopProxies") : t("shared.genProxies", { verb })}</ContextMenuItem>

            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuLabel>{t("shared.thumbSize")}</ContextMenuLabel>
              <ContextMenuItem closeOnClick={false} onClick={() => p.setCols(stepCols(p.cols, -1, p.maxCols))} disabled={!canFewerCols(p.cols)}>
                <NetsuIcon name="add" /> {t("cutMenu.larger")}
              </ContextMenuItem>
              <ContextMenuItem closeOnClick={false} onClick={() => p.setCols(stepCols(p.cols, 1, p.maxCols))} disabled={!canMoreCols(p.cols, p.maxCols)}>
                <NetsuIcon name="remove" /> {t("cutMenu.smaller")}
              </ContextMenuItem>
            </ContextMenuGroup>
            {!p.compact && (
              <ContextMenuCheckboxItem checked={p.playerOpen} onClick={() => p.setPlayerOpen((v) => !v)}>
                <NetsuIcon name="panel-right-toggle" /> {t("cutMenu.rightPlayer")}
              </ContextMenuCheckboxItem>
            )}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
