// L'effort de réflexion, en CURSEUR plutôt qu'en rangée de boutons (repris de Codex).
//
// Cinq paliers, c'est une échelle : « plus » et « moins » se lisent d'un coup d'œil sur une piste,
// là où cinq boutons côte à côte demandaient de lire cinq libellés pour retrouver où on en était.
// Le palier retenu est écrit en toutes lettres au-dessus — un cran sans nom ne veut rien dire —
// avec le modèle qui le reçoit, parce que l'effort ne se règle pas dans l'absolu mais POUR un moteur.
//
// Piste discrète : `min=0 max=4 step=1`, donc le pouce s'aimante déjà sur les crans. Les cinq points
// ne sont que le repère visuel du nombre de crans, jamais des cibles séparées — on peut cliquer la
// piste n'importe où, glisser, ou pousser aux flèches (Base UI s'en charge).
//
// Il vit dans SON menu, à côté de celui du modèle et pas dedans : deux décisions, deux boutons. Le
// curseur coincé sous la liste des modèles obligeait à dérouler tout un catalogue pour monter d'un
// cran. (Codex met un éclair à gauche du palier — c'est son mode ultra-rapide, qui n'existe sur
// aucune de nos lignes de commande ; l'icône n'aurait rien désigné ici.)
import { Slider } from "@base-ui/react/slider";
import { useTranslation } from "react-i18next";
import { ChevronRight, RotateCcw } from "lucide-react";
import type { ChatThinking } from "@/lib/bridge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** L'échelle de `claude --effort`, la plus large des échelles réelles. */
export const THINKING_LEVELS: ChatThinking[] = ["low", "medium", "high", "xhigh", "max"];
/** Le cran d'origine : celui vers lequel ramène le bouton de réinitialisation. */
export const THINKING_DEFAULT: ChatThinking = "medium";

export function ThinkingSlider({ value, onChange, model, onPickModel, className }: {
  value: ChatThinking;
  onChange: (next: ChatThinking) => void;
  /** Modèle qui reçoit l'effort, écrit sous le palier. */
  model: string;
  /** Bascule vers le catalogue de modèles : la ligne du modèle EST ce bouton. */
  onPickModel?: () => void;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const index = Math.max(0, THINKING_LEVELS.indexOf(value));
  const atDefault = value === THINKING_DEFAULT;

  return (
    // Pas de cadre à lui : il EST le contenu de sa fenêtre, qui en a déjà un. Encadré une seconde
    // fois, on voyait une boîte dans une boîte à 6 px d'écart.
    <div className={cn("px-2 pb-2 pt-1.5", className)}
      // La saisie clavier du curseur ne doit pas nourrir la navigation typeahead du menu qui
      // l'héberge : les flèches y changeraient d'entrée au lieu de changer de cran.
      onKeyDown={(event) => event.stopPropagation()}>
      <div className="flex items-center gap-2">
        {/* Réservé à la largeur EXACTE du bouton d'en face (`size-6` des deux côtés) : sans lui le
            bloc central est décentré de la moitié du bouton, et deux tailles différentes le
            décentrent des quelques pixels d'écart. */}
        <span aria-hidden="true" className="size-6 shrink-0" />
        <div className="min-w-0 flex-1 text-center">
          {/* Le modèle EN PREMIER : c'est le contexte (« l'effort de quoi ? »), le palier est la
              valeur qu'on vient régler et se lit juste au-dessus de la piste qui le change.

              Le chevron est posé DANS le rembourrage droit, pas dans le flux : compté comme un
              enfant de plus, il décalait le texte d'une demi-largeur de chevron vers la gauche, et
              les deux lignes empilées n'avaient plus le même centre optique. */}
          {onPickModel ? (
            <button type="button" onClick={onPickModel}
              className="relative inline-flex max-w-full items-center rounded px-3.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="truncate">{model || t("engine.default")}</span>
              <ChevronRight className="absolute right-0 size-3 shrink-0 opacity-70" />
            </button>
          ) : (
            <div className="truncate text-[10px] text-muted-foreground">{model || t("engine.default")}</div>
          )}
          <div className="truncate text-xs font-medium text-primary">{t(`thinking.${value}`)}</div>
        </div>
        <Tooltip>
          <TooltipTrigger render={
            <button type="button" aria-label={t("thinkingSlider.reset")} disabled={atDefault}
              onClick={() => onChange(THINKING_DEFAULT)}
              className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground" />
          }>
            <RotateCcw className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>{t("thinkingSlider.reset")}</TooltipContent>
        </Tooltip>
      </div>

      <Slider.Root
        className="mt-2"
        value={index}
        min={0}
        max={THINKING_LEVELS.length - 1}
        step={1}
        thumbAlignment="edge"
        onValueChange={(next) => {
          const level = THINKING_LEVELS[Array.isArray(next) ? next[0] : next];
          if (level && level !== value) onChange(level);
        }}
      >
        <Slider.Control className="relative flex h-5 w-full touch-none items-center select-none">
          <Slider.Track className="relative h-1 w-full rounded-full bg-foreground/15">
            {/* Repères : posés sur la piste, jamais cliquables — la piste entière l'est déjà, et
                cinq cibles de 4 px seraient plus dures à viser qu'elle. */}
            {THINKING_LEVELS.map((level, position) => (
              <span key={level} aria-hidden="true"
                className={cn("absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors",
                  position <= index ? "bg-primary/70" : "bg-foreground/30")}
                style={{ left: `calc(${(position / (THINKING_LEVELS.length - 1)) * 100}% + ${8 - position * 4}px)` }} />
            ))}
            <Slider.Indicator className="h-full rounded-full bg-primary/60 select-none" />
          </Slider.Track>
          <Slider.Thumb
            aria-label={t("engine.thinking")}
            className="block size-4 shrink-0 rounded-full bg-foreground shadow-sm ring-ring/50 transition-[box-shadow] select-none hover:ring-4 focus-visible:ring-4 focus-visible:outline-none" />
        </Slider.Control>
      </Slider.Root>
    </div>
  );
}
