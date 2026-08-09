import { useCallback, useEffect, useRef, useState } from "react";
import { Volume, Volume1, Volume2, VolumeX } from "lucide-react";
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { animate, motion, useMotionValue, useMotionValueEvent, useTransform } from "framer-motion";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

// Amplitude (px) de l'étirement de la piste quand on tire au-delà d'un bord. Discrète : l'effet
// caoutchouc doit se sentir, pas se voir.
const MAX_OVERFLOW = 8;
// Épaisseurs de la piste (repos / survol). La boîte qui la porte garde TOUJOURS la plus grande :
// animer la hauteur du conteneur poussait la mise en page du lecteur de 2 px au survol.
const TRACK_H = 3;
const TRACK_H_HOVER = 5;
const WHEEL_STEP = 0.05;
// Pas des flèches clavier « longues » (Page Haut/Bas, Maj+flèche) ; les flèches seules gardent le pas fin.
const LARGE_STEP = 0.05;
// Volume rendu quand on rétablit le son alors qu'il ne reste rien à restaurer (curseur à 0 au boot).
const DEFAULT_RESTORE = 0.2;

export type VolumeSliderProps = {
  value: number;
  onChange: (value: number) => void;
  /**
   * Coupure EXPLICITE, séparée du niveau (le volume reste mémorisé pendant la coupure). Sans ce
   * couple, le bouton du curseur coupe en posant le volume à 0 et le rétablit à sa valeur d'avant.
   */
  muted?: boolean;
  onMutedChange?: (muted: boolean) => void;
  /**
   * Bascule muet fournie par l'appelant (lecteurs : `useVolumeState`, qui partage la mémoire du
   * dernier volume audible avec le raccourci M et le menu contextuel). Prime sur les deux autres
   * mécaniques — sinon le bouton et le raccourci restaureraient des valeurs différentes.
   */
  onToggleMute?: () => void;
  disabled?: boolean;
  /** Pourcentage (ou « muet ») à droite du curseur. */
  showValue?: boolean;
  /** Étiquette du curseur pour les lecteurs d'écran (défaut : « Volume »). */
  label?: string;
  className?: string;
};

function iconFor(level: number) {
  if (level < 0.34) return Volume;
  if (level < 0.67) return Volume1;
  return Volume2;
}

// Décroissance sigmoïde : l'overflow ralentit en s'éloignant du bord (effet élastique).
function decay(value: number, max: number) {
  if (max === 0) return 0;
  const entry = value / max;
  const sigmoid = 2 * (1 / (1 + Math.exp(-entry)) - 0.5);
  return sigmoid * max;
}

/**
 * Curseur de volume AUTOSUFFISANT : bouton de coupure intégré (à gauche, icône selon le niveau),
 * molette, flèches clavier et lecture du niveau. Les appelants n'ont plus à câbler leur propre
 * bouton muet à côté — c'était la source d'incohérences (bouton coupé ici, curseur inerte là).
 * Couleur héritée du parent (`bg-current`) : lisible sur une vidéo comme sur un panneau.
 */
export function VolumeSlider({
  value, onChange, muted, onMutedChange, onToggleMute, disabled = false, showValue = false, label, className,
}: VolumeSliderProps) {
  const { t } = useTranslation("common");
  const [region, setRegion] = useState<"left" | "middle" | "right">("middle");
  const clientX = useMotionValue(0);
  const overflow = useMotionValue(0);
  const expand = useMotionValue(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Dernier niveau audible, pour le rétablir après une coupure.
  const lastAudible = useRef(value > 0 ? value : DEFAULT_RESTORE);
  if (value > 0) lastAudible.current = value;

  const silent = (muted ?? false) || value <= 0;

  const setLevel = useCallback((next: number) => {
    const level = Math.min(1, Math.max(0, Math.round(next * 100) / 100));
    // Bouger le curseur rétablit le son : régler un volume tout en restant coupé n'a aucun sens.
    if (level > 0 && muted && onMutedChange) onMutedChange(false);
    onChange(level);
  }, [muted, onMutedChange, onChange]);

  const toggleMute = useCallback(() => {
    if (onToggleMute) { onToggleMute(); return; }
    if (onMutedChange) {
      onMutedChange(!silent);
      if (silent && value <= 0) onChange(lastAudible.current || DEFAULT_RESTORE);
      return;
    }
    if (value > 0) { lastAudible.current = value; onChange(0); return; }
    onChange(lastAudible.current || DEFAULT_RESTORE);
  }, [onToggleMute, onMutedChange, onChange, silent, value]);

  // Molette : listener natif non passif (React attache `onWheel` en passif → preventDefault ignoré,
  // la page défilerait sous le curseur).
  useEffect(() => {
    const el = rootRef.current;
    if (!el || disabled) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setLevel(value + (event.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [disabled, setLevel, value]);

  useMotionValueEvent(clientX, "change", (latest) => {
    if (!trackRef.current) return;
    const { left, right } = trackRef.current.getBoundingClientRect();
    let past = 0;
    if (latest < left) { setRegion("left"); past = left - latest; }
    else if (latest > right) { setRegion("right"); past = latest - right; }
    else { setRegion("middle"); past = 0; }
    overflow.jump(decay(past, MAX_OVERFLOW));
  });

  const Icon = silent ? VolumeX : iconFor(value);
  const thumbX = useTransform(() => (region === "left" ? -overflow.get() : region === "right" ? overflow.get() : 0));

  return (
    <motion.div
      ref={rootRef}
      onHoverStart={() => animate(expand, 1, { duration: 0.15 })}
      onHoverEnd={() => animate(expand, 0, { duration: 0.15 })}
      className={cn(
        "group flex w-full touch-none items-center gap-1.5 select-none",
        disabled && "pointer-events-none opacity-40",
        className,
      )}
    >
      <motion.button
        type="button"
        onClick={toggleMute}
        aria-label={silent ? t("player.soundOn") : t("player.soundOff")}
        aria-pressed={silent}
        animate={{ scale: region === "left" ? [1, 1.12, 1] : 1 }}
        transition={{ duration: 0.22 }}
        style={{ x: useTransform(() => (region === "left" ? -overflow.get() : 0)) }}
        className="grid size-5 shrink-0 place-items-center rounded-full opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
      >
        <Icon className="size-3.5" />
      </motion.button>

      <SliderPrimitive.Root
        value={value}
        min={0}
        max={1}
        step={0.01}
        largeStep={LARGE_STEP}
        // « edge » garde la pastille DANS la piste. Centrée sur la valeur, elle déborde d'un rayon à
        // 100 % : rognée en demi-lune par les conteneurs `overflow-hidden` (volume repliable du
        // lecteur), et visible à côté de l'icône même une fois la piste repliée à zéro.
        thumbAlignment="edge"
        disabled={disabled}
        onValueChange={(next) => setLevel(Array.isArray(next) ? next[0] : next)}
        className="relative flex w-full grow touch-none items-center select-none"
      >
        <SliderPrimitive.Control
          ref={trackRef}
          className="relative flex w-full grow cursor-grab items-center py-2 active:cursor-grabbing"
          onPointerDown={() => animate(expand, 1, { duration: 0.12 })}
          onPointerMove={(e) => { if (e.buttons > 0) clientX.jump(e.clientX); }}
          onLostPointerCapture={() => animate(overflow, 0, { type: "spring", bounce: 0.35, duration: 0.45 })}
        >
          <motion.div
            style={{
              scaleX: useTransform(() => {
                if (!trackRef.current) return 1;
                const { width } = trackRef.current.getBoundingClientRect();
                return 1 + overflow.get() / width;
              }),
              scaleY: useTransform(overflow, [0, MAX_OVERFLOW], [1, 0.85]),
              transformOrigin: useTransform(() => {
                if (!trackRef.current) return "center";
                const { left, width } = trackRef.current.getBoundingClientRect();
                return clientX.get() < left + width / 2 ? "right" : "left";
              }),
              height: TRACK_H_HOVER,
            }}
            className="flex grow items-center"
          >
            <SliderPrimitive.Track
              render={<motion.div style={{ height: useTransform(expand, [0, 1], [TRACK_H, TRACK_H_HOVER]) }} />}
              className="relative isolate grow overflow-hidden rounded-full bg-current/25"
            >
              <SliderPrimitive.Indicator className={cn("h-full rounded-full bg-current transition-opacity", silent && "opacity-40")} />
            </SliderPrimitive.Track>
          </motion.div>
          <SliderPrimitive.Thumb
            aria-label={label ?? t("player.volume")}
            // La pastille suit l'étirement de la piste : sans ça, tirer au-delà d'un bord allongeait
            // la piste SOUS une pastille restée à sa butée — elle semblait ne pas atteindre le bout.
            render={<motion.div style={{ x: thumbX }} />}
            className="block size-2 rounded-full bg-current opacity-0 shadow transition-opacity group-hover:opacity-100 data-dragging:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-current/40 focus-visible:outline-none"
          />
        </SliderPrimitive.Control>
      </SliderPrimitive.Root>

      {showValue && (
        <span className="w-10 shrink-0 text-right text-[11px] tabular-nums opacity-70">
          {silent ? t("player.muted") : `${Math.round(value * 100)} %`}
        </span>
      )}
    </motion.div>
  );
}
