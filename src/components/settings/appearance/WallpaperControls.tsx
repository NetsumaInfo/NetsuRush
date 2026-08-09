// Réglages du fond d'écran, en rangées denses groupées par intention. Le CADRAGE n'est pas ici : il
// se règle dans une fenêtre dédiée, sur l'image elle-même (cf. WallpaperFramingDialog) — le placer
// dans des curseurs revenait à faire deviner à l'utilisateur ce qu'il allait obtenir.
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Crop } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { NumberSpin } from "@/components/ui/number-spin";
import {
  MAX_BLUR_PX,
  MIN_UI_OPACITY,
  previewWallpaperSetting,
  type WallpaperConfig,
  type WallpaperLiveKey,
} from "@/lib/wallpaper";

interface Props {
  config: WallpaperConfig;
  /** Le fond sélectionné est-il animé ? Conditionne les commandes de lecture. */
  animated: boolean;
  onChange: (patch: Partial<WallpaperConfig>) => void;
  onOpenFraming: () => void;
}

/** Un groupe = un intitulé discret et ses rangées, séparés par un filet. Pas de carte par réglage. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border/60 pt-3 first:border-t-0 first:pt-0">
      <h4 className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h4>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

/**
 * Rangée d'un réglage continu : intitulé, curseur, valeur SAISISSABLE. Le curseur donne le geste,
 * le champ donne le chiffre exact — un curseur seul ne permet jamais de viser une valeur précise.
 *
 * La valeur vit en état LOCAL le temps du geste, et c'est ce local que LES DEUX commandes affichent.
 * Le curseur seul en local laissait le champ figé sur la valeur enregistrée : la poignée bougeait,
 * le chiffre non, ce qui se lit comme un réglage qui ne répond pas. `previewWallpaperSetting` pose
 * les variables CSS à chaque frame (le compositeur seul travaille) ; le store n'est écrit qu'au
 * relâchement, sinon chaque frame réécrirait localStorage et re-rendrait la page.
 */
function LiveRow({
  label, setting, value, unit, min, max, onCommit,
}: {
  label: string;
  setting: WallpaperLiveKey;
  value: number;
  unit: string;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);

  const preview = (next: number) => {
    setLocal(next);
    previewWallpaperSetting(setting, next);
  };
  const readSlider = (next: number | readonly number[]) => Number(Array.isArray(next) ? next[0] : next);

  return (
    <div className="grid grid-cols-1 items-center gap-x-3 gap-y-1 sm:grid-cols-[7.5rem_1fr_auto]">
      <span className="text-[0.8125rem] text-muted-foreground">{label}</span>
      <div className="min-w-0">
        <Slider
          value={[local]}
          min={min}
          max={max}
          step={1}
          aria-label={label}
          onValueChange={(next) => preview(readSlider(next))}
          onValueCommitted={(next) => onCommit(readSlider(next))}
        />
      </div>
      <div className="flex items-center gap-1.5 sm:justify-end">
        <NumberSpin
          value={local}
          min={min}
          max={max}
          step={1}
          ariaLabel={label}
          onCommit={(next) => { preview(next); onCommit(next); }}
        />
        <span className="w-4 text-xs text-muted-foreground">{unit}</span>
      </div>
    </div>
  );
}

/** Bascule on/off : une case à cocher dit son état sans dépendre d'un fond, contrairement à un bouton pressé. */
function Check({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <Label htmlFor={id} className="text-[0.8125rem] font-normal">{label}</Label>
    </div>
  );
}

export function WallpaperControls({ config, animated, onChange, onOpenFraming }: Props) {
  const { t } = useTranslation("settings");
  const label = (key: string) => t(`appearance.wallpaper.${key}`);

  return (
    <div className="flex flex-col gap-3">
      <Group title={label("groupFraming")}>
        <Button variant="outline" size="sm" onClick={onOpenFraming} className="w-full sm:w-auto">
          <Crop className="size-3.5" /> {label("openFraming")}
        </Button>
      </Group>

      <Group title={label("groupRender")}>
        <LiveRow
          label={label("blur")}
          setting="blur"
          value={config.blur}
          unit="px"
          min={0}
          max={MAX_BLUR_PX}
          onCommit={(blur) => onChange({ blur })}
        />
        <LiveRow
          label={label("saturate")}
          setting="saturate"
          value={config.saturate}
          unit="%"
          min={0}
          max={200}
          onCommit={(saturate) => onChange({ saturate })}
        />
      </Group>

      <Group title={label("groupReadability")}>
        <LiveRow
          label={label("opacity")}
          setting="opacity"
          value={config.opacity}
          unit="%"
          min={0}
          max={100}
          onCommit={(opacity) => onChange({ opacity })}
        />
        <LiveRow
          label={label("uiOpacity")}
          setting="uiOpacity"
          value={config.uiOpacity}
          unit="%"
          min={MIN_UI_OPACITY}
          max={100}
          onCommit={(uiOpacity) => onChange({ uiOpacity })}
        />
      </Group>

      <Group title={label("groupScope")}>
        <Check
          id="wp-detached"
          label={label("onDetached")}
          checked={config.onDetached}
          onChange={(onDetached) => onChange({ onDetached })}
        />
      </Group>

      {animated ? (
        <Group title={label("groupMotion")}>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <Check id="wp-animate" label={label("animate")} checked={config.animate} onChange={(animate) => onChange({ animate })} />
            <Check
              id="wp-pause-unfocused"
              label={label("pauseUnfocused")}
              checked={config.pauseUnfocused}
              onChange={(pauseUnfocused) => onChange({ pauseUnfocused })}
            />
            <Check
              id="wp-pause-busy"
              label={label("pauseWhileBusy")}
              checked={config.pauseWhileBusy}
              onChange={(pauseWhileBusy) => onChange({ pauseWhileBusy })}
            />
          </div>
        </Group>
      ) : null}
    </div>
  );
}
