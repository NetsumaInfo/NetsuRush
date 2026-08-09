// Retouches de couleur par-dessus le thème choisi : accent (donc icônes actives et sélection),
// texte, fonds, bordures. Mémorisé par thème, comme le fond d'écran.
//
// Le sélecteur vient de `ui/color-picker` — source unique de tout choix de couleur dans l'app. En
// écrire un second ici, c'est garantir deux comportements différents pour le même geste.
//
// PERF : `ColorPicker` n'expose qu'un `onChange`, appelé à chaque frame du glissement. Passer par le
// store à chaque appel réécrivait localStorage et re-rendait les cinq pastilles — d'où le glissement
// pâteux. La couleur est donc posée DIRECTEMENT en variable CSS pendant le geste, et le store n'est
// touché qu'une fois le geste retombé.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { applyThemeColorVar, THEME_COLOR_KEYS, type ThemeColorKey, type ThemeColorOverrides } from "@/lib/themeColors";
import { appearanceKey } from "@/lib/customThemes";
import { useApp } from "@/store";

/**
 * Repli STABLE pour un thème sans retouche. Un `?? {}` dans le sélecteur zustand fabriquerait un
 * objet neuf à chaque appel : le store se croirait modifié à chaque rendu et la page bouclerait
 * jusqu'au « Maximum update depth exceeded ».
 */
const NO_OVERRIDES: ThemeColorOverrides = {};
/** Repos du geste au-delà duquel on enregistre. Assez court pour ne pas se remarquer. */
const COMMIT_DELAY_MS = 180;

export function ThemeColorsCard() {
  const { t } = useTranslation("settings");
  const key = useApp((s) => appearanceKey(s.theme, s.customThemeId));
  const overrides = useApp((s) => s.themeColors[appearanceKey(s.theme, s.customThemeId)]) ?? NO_OVERRIDES;
  const setThemeColor = useApp((s) => s.setThemeColor);
  const resetThemeColors = useApp((s) => s.resetThemeColors);

  // Couleurs en cours de glissement : elles priment sur le store le temps du geste.
  const [draft, setDraft] = useState<ThemeColorOverrides>({});
  const timers = useRef(new Map<ThemeColorKey, ReturnType<typeof setTimeout>>());

  // Changer de thème abandonne un geste en cours : ses valeurs appartiennent au thème précédent.
  useEffect(() => { setDraft({}); }, [key]);
  useEffect(() => {
    const pending = timers.current;
    return () => { for (const timer of pending.values()) clearTimeout(timer); };
  }, []);

  const change = useCallback((color: ThemeColorKey, value: string) => {
    setDraft((d) => ({ ...d, [color]: value }));
    applyThemeColorVar(color, value); // aperçu immédiat, sans store ni disque
    const timer = timers.current.get(color);
    if (timer) clearTimeout(timer);
    timers.current.set(color, setTimeout(() => {
      timers.current.delete(color);
      setThemeColor(color, value);
      setDraft((d) => { const next = { ...d }; delete next[color]; return next; });
    }, COMMIT_DELAY_MS));
  }, [setThemeColor]);

  const restore = useCallback((color: ThemeColorKey) => {
    const timer = timers.current.get(color);
    if (timer) clearTimeout(timer);
    timers.current.delete(color);
    setDraft((d) => { const next = { ...d }; delete next[color]; return next; });
    setThemeColor(color, null);
  }, [setThemeColor]);

  // Couleurs du thème lues UNE fois par thème : `getComputedStyle` force un recalcul de style, le
  // rappeler à chaque rendu pour chacune des cinq pastilles hachait le glissement.
  const themeDefaults = useMemo(() => {
    if (typeof document === "undefined") return {} as Record<ThemeColorKey, string>;
    const computed = getComputedStyle(document.documentElement);
    return Object.fromEntries(THEME_COLOR_KEYS.map((color) => {
      const stored = overrides[color];
      const value = stored ?? computed.getPropertyValue(`--color-${color === "primary" ? "primary" : color}`).trim();
      return [color, value || "#000000"];
    })) as Record<ThemeColorKey, string>;
    // `key` suffit : une retouche enregistrée passe par `overrides`, relire le calculé n'apporte rien.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const touched = Object.keys(overrides).length > 0;

  return (
    <section className="flex flex-col gap-3 border-t border-border pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-medium">{t("appearance.colors.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("appearance.colors.perTheme")}</p>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2.5">
        {THEME_COLOR_KEYS.map((color) => {
          const overridden = draft[color] ?? overrides[color];
          return (
            <div key={`${key}-${color}`} className="flex items-center gap-2 rounded-lg border border-border p-2">
              <ColorPicker
                value={overridden ?? themeDefaults[color]}
                onChange={(value) => change(color, value)}
                ariaLabel={t(`appearance.colors.${color}`)}
                side="bottom"
              />
              {/* Hauteur RÉSERVÉE et libellé de longueur constante : la ligne d'état changeait de
                  texte au premier choix de couleur, ce qui rallongeait la carte et faisait sauter
                  toute la grille sous le curseur. */}
              <div className="min-w-0 flex-1">
                <span className="block truncate text-[0.8125rem]">{t(`appearance.colors.${color}`)}</span>
                <button
                  type="button"
                  onClick={() => restore(color)}
                  disabled={!overridden}
                  className={cn(
                    "block h-4 truncate text-[11px] outline-none",
                    overridden
                      ? "text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:underline"
                      : "cursor-default text-muted-foreground/60",
                  )}
                >
                  {overridden ? t("appearance.colors.restore") : t("appearance.colors.fromTheme")}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Rangée TOUJOURS montée, désactivée tant que rien n'est retouché : la faire apparaître au
          premier choix de couleur rallongeait la carte, et tout ce qui suit sautait — filet de
          section compris — au moment précis où l'on glisse dans le sélecteur. */}
      <div className="flex justify-end">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button size="sm" variant="ghost" disabled={!touched} onClick={resetThemeColors}>
                <RotateCcw className="size-3.5" /> {t("appearance.colors.resetAll")}
              </Button>
            }
          />
          <TooltipContent>{t("appearance.colors.resetAllHint")}</TooltipContent>
        </Tooltip>
      </div>
    </section>
  );
}
