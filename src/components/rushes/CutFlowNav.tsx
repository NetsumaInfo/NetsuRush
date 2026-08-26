import { useTranslation } from "react-i18next";
import { Layers } from "lucide-react";
import type { Clip } from "@/lib/bridge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmt } from "./cutStudioShared";
import { scrollOffsetOfShot, useFlowPosition } from "./cutFlow";
import type { FlowSource } from "./useShotDetection";

// Entête d'un FLUX : nom du rush qu'on a sous les yeux, sa définition, sa durée, et le saut direct
// vers n'importe quel autre.
//
// C'est un composant à part pour une raison de performance, pas de rangement : c'est la SEULE chose
// de la page qui réagit au défilement. Tenu dans CutStudio, franchir une frontière de rush re-rendait
// le studio entier — donc reconstruisait les centaines de vignettes de la grille, exactement pendant
// qu'on défile. Ici, un changement de rush ne re-rend que cette ligne.
export function CutFlowNav({ flow, offsets, cell, cols, scrollEl, sourceOf, total }: {
  flow: Clip[];
  /** Rang du premier plan de chaque rush dans la grille aplatie (cf. flowOffsets). */
  offsets: number[];
  cell: number;
  cols: number;
  scrollEl: HTMLElement | null;
  sourceOf: (path: string | undefined) => FlowSource;
  /** Durée cumulée du flux. */
  total: number;
}) {
  const { t } = useTranslation("derush");
  const index = useFlowPosition(scrollEl, offsets, cell, cols, flow.length > 1);
  const current = flow[index] ?? flow[0];
  const source = sourceOf(current?.path);

  // Saut direct : la première vignette du rush visé se cale en haut de la zone. Pas d'animation —
  // un flux se parcourt à la molette, le saut est un déplacement, pas une transition.
  const jump = (i: number) => {
    if (scrollEl) scrollEl.scrollTop = scrollOffsetOfShot(offsets[i] ?? 0, cell, cols);
  };

  return (
    <>
      <Select value={String(index)} onValueChange={(v) => jump(Number(v))}>
        <SelectTrigger
          size="sm"
          className="h-6 w-auto max-w-full gap-1.5 border-0 bg-transparent px-1 shadow-none hover:bg-accent"
          aria-label={t("cutStudio.flowJump")}
        >
          <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {/* Base UI rend la VALEUR quand on ne lui donne rien : sans cet enfant explicite, l'entête
              affichait le rang brut (« 0 ») au lieu du nom du rush. */}
          <SelectValue>
            <span className="truncate text-[13px] font-medium leading-tight">{current?.name}</span>
          </SelectValue>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{index + 1}/{flow.length}</span>
        </SelectTrigger>
        <SelectContent className="max-w-[min(40rem,var(--available-width))]">
          {flow.map((c, i) => (
            <SelectItem key={c.path} value={String(i)}>
              <span className="block truncate">{`${i + 1}. ${c.name}`}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="truncate pl-1 text-[11px] leading-tight text-muted-foreground">
        {source.info && `${source.info.width}×${source.info.height} · `}
        {fmt(source.duration)}
        {` · ${t("cutStudio.flowRushes", { count: flow.length })} · ${fmt(total)}`}
      </div>
    </>
  );
}
