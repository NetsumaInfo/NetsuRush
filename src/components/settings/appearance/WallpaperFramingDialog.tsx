// Fenêtre de recadrage du fond : l'image entière, un rectangle tracé dessus, des poignées aux coins.
//
// Le rectangle a TOUJOURS le format de la fenêtre de l'application, et ce n'est pas une limitation :
// un fond remplit la fenêtre, donc une région d'un autre format serait de toute façon re-rognée à
// l'affichage. Proposer 16:9 / 4:3 / 1:1 revenait à montrer un cadrage que l'utilisateur n'obtenait
// pas. Ici, ce qui est dans le rectangle est exactement ce qui s'affiche.
//
// Le recadrage n'est pas cuit dans le fichier : un même fond est partagé par plusieurs thèmes, qui
// n'en veulent pas forcément la même région. Il vit dans la transformation CSS de la couche.
//
// Les modifications restent en BROUILLON jusqu'à « Appliquer » : recadrer en direct ferait clignoter
// tout le fond de l'application derrière la fenêtre à chaque pixel de glissement.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlipHorizontal, FlipVertical, RotateCcw, RotateCw, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NumberSpin } from "@/components/ui/number-spin";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { nr } from "@/lib/bridge";
import { FULL_CROP, centeredCrop, moveCrop, resizeCrop, type CropHandle, type CropRect } from "@/lib/cropRect";
import type { WallpaperConfig, WallpaperRotation } from "@/lib/wallpaper";
import { cn } from "@/lib/utils";

interface FramingMedia {
  path: string;
  /** Boucle vidéo plutôt qu'image fixe. Un fond animé se cadre EN MOUVEMENT : sur une image figée,
   *  rien ne dit si le sujet reste dans le cadre une seconde plus tard. */
  animated: boolean;
  width: number;
  height: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: WallpaperConfig;
  media: FramingMedia;
  onChange: (patch: Partial<WallpaperConfig>) => void;
}

const HANDLES: CropHandle[] = ["nw", "ne", "sw", "se"];
const HANDLE_STYLE: Record<CropHandle, string> = {
  nw: "-top-2 -left-2 cursor-nwse-resize",
  ne: "-top-2 -right-2 cursor-nesw-resize",
  sw: "-bottom-2 -left-2 cursor-nesw-resize",
  se: "-bottom-2 -right-2 cursor-nwse-resize",
};
const QUARTER_TURN = 90;
const TURNS = 360;

function useWindowRatio(): number {
  const [ratio, setRatio] = useState(() => (typeof window === "undefined" ? 16 / 9 : window.innerWidth / window.innerHeight));
  useEffect(() => {
    const sync = () => setRatio(window.innerWidth / window.innerHeight);
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
  return ratio;
}

/**
 * L'image à cadrer, jouée si elle est animée. Muette et en boucle : c'est un repère de cadrage, pas
 * une lecture. `key` sur l'URL pour que changer de fond reparte d'un élément neuf.
 */
function FramingMediaView({ media, className, style }: { media: FramingMedia; className: string; style?: React.CSSProperties }) {
  const src = nr.mediaUrl(media.path);
  if (media.animated) {
    return <video key={src} src={src} className={className} style={style} autoPlay loop muted playsInline preload="auto" />;
  }
  return <img key={src} src={src} alt="" draggable={false} decoding="async" className={className} style={style} />;
}

export function WallpaperFramingDialog({ open, onOpenChange, config, media, onChange }: Props) {
  const { t } = useTranslation("settings");
  const label = (key: string) => t(`appearance.wallpaper.${key}`);
  const windowRatio = useWindowRatio();
  const imageRatio = media.width && media.height ? media.width / media.height : windowRatio;
  // Un quart de tour échange les axes : le rectangle doit alors viser le format INVERSE, sinon la
  // région cadrée ne remplit plus la fenêtre une fois l'image tournée.
  const [draft, setDraft] = useState<WallpaperConfig>(config);
  const quarter = draft.rotate === 90 || draft.rotate === 270;
  /** Format visé, exprimé en unités d'IMAGE (le rectangle vit en normalisé, pas en pixels). */
  const lockedRatio = (quarter ? 1 / windowRatio : windowRatio) / imageRatio;

  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: "move" | CropHandle; x: number; y: number; origin: CropRect } | null>(null);

  // Rouvrir repart TOUJOURS de l'état enregistré : un brouillon abandonné ne doit pas réapparaître.
  useEffect(() => { if (open) setDraft(config); }, [open, config]);

  const setCrop = (crop: CropRect) => setDraft((d) => ({ ...d, crop }));

  const onPointerDown = (mode: "move" | CropHandle) => (event: React.PointerEvent) => {
    event.stopPropagation();
    boxRef.current?.setPointerCapture(event.pointerId);
    drag.current = { mode, x: event.clientX, y: event.clientY, origin: draft.crop };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const start = drag.current;
    const box = boxRef.current;
    if (!start || !box) return;
    const rect = box.getBoundingClientRect();
    const dx = (event.clientX - start.x) / rect.width;
    const dy = (event.clientY - start.y) / rect.height;
    setCrop(start.mode === "move"
      ? moveCrop(start.origin, dx, dy)
      : resizeCrop(start.origin, start.mode, dx, dy, lockedRatio));
  };

  const endDrag = () => { drag.current = null; };

  const turn = (direction: 1 | -1) => setDraft((d) => {
    const rotate = ((d.rotate + direction * QUARTER_TURN + TURNS) % TURNS) as WallpaperRotation;
    // Le format visé change avec le quart de tour : on recentre un rectangle valide plutôt que de
    // laisser à l'écran un cadrage qui ne remplirait plus la fenêtre.
    const nextQuarter = rotate === 90 || rotate === 270;
    const ratio = (nextQuarter ? 1 / windowRatio : windowRatio) / imageRatio;
    return { ...d, rotate, crop: centeredCrop(ratio) };
  });

  // Dimensions de la région retenue, en pixels de la SOURCE : le seul chiffre qui parle vraiment.
  const cropPixels = {
    w: Math.round(draft.crop.w * media.width),
    h: Math.round(draft.crop.h * media.height),
  };
  /** Saisir une dimension redimensionne depuis le coin haut-gauche, en gardant le format. */
  const setCropWidth = (px: number) => {
    const w = Math.min(1, Math.max(0.05, px / (media.width || 1)));
    const h = Math.min(1, w / lockedRatio);
    setCrop({ x: Math.min(draft.crop.x, 1 - w), y: Math.min(draft.crop.y, 1 - h), w, h });
  };

  const apply = () => {
    onChange({ crop: draft.crop, rotate: draft.rotate, flipH: draft.flipH, flipV: draft.flipV });
    onOpenChange(false);
  };

  const imageTransform = [
    draft.rotate ? `rotate(${draft.rotate}deg)` : "",
    draft.flipH || draft.flipV ? `scale(${draft.flipH ? -1 : 1}, ${draft.flipV ? -1 : 1})` : "",
  ].filter(Boolean).join(" ") || undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `sm:max-w-*` et non `max-w-*` : le composant porte déjà `sm:max-w-md`, et une variante
          différente ne le remplace pas — au-delà de 640 px la fenêtre restait à 448 px. */}
      <DialogContent className="w-[min(96vw,72rem)] sm:max-w-[72rem]">
        <DialogHeader>
          <DialogTitle>{label("framingTitle")}</DialogTitle>
        </DialogHeader>

        <div
          ref={boxRef}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{ aspectRatio: String(imageRatio), maxHeight: "min(58vh, 32rem)" }}
          className="relative mx-auto w-full overflow-hidden rounded-lg border border-border bg-black/40 select-none"
        >
          <FramingMediaView
            media={media}
            className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-35"
            style={{ transform: imageTransform }}
          />
          {/* La région retenue est repeinte NETTE par-dessus la version assombrie : le contraste
              entre gardé et écarté se lit sans légende. */}
          <div
            onPointerDown={onPointerDown("move")}
            style={{
              left: `${draft.crop.x * 100}%`,
              top: `${draft.crop.y * 100}%`,
              width: `${draft.crop.w * 100}%`,
              height: `${draft.crop.h * 100}%`,
            }}
            className="absolute cursor-move overflow-hidden outline-2 outline-primary"
          >
            <FramingMediaView
              media={media}
              className="pointer-events-none absolute h-full w-full max-w-none object-contain"
              style={{
                width: `${100 / draft.crop.w}%`,
                height: `${100 / draft.crop.h}%`,
                left: `${(-draft.crop.x / draft.crop.w) * 100}%`,
                top: `${(-draft.crop.y / draft.crop.h) * 100}%`,
                transform: imageTransform,
              }}
            />
            {HANDLES.map((handle) => (
              <span
                key={handle}
                onPointerDown={onPointerDown(handle)}
                className={cn(
                  "absolute size-4 rounded-full border-2 border-background bg-primary shadow-sm",
                  HANDLE_STYLE[handle],
                )}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label("cropSize")}</span>
            <div className="flex items-center gap-2">
              <NumberSpin
                value={cropPixels.w}
                min={1}
                max={media.width || 9999}
                step={10}
                ariaLabel={label("cropWidth")}
                onCommit={setCropWidth}
              />
              <span className="text-xs text-muted-foreground">× {cropPixels.h} px</span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label("transform")}</span>
            <div className="flex flex-wrap gap-1.5">
              <IconAction label={label("rotateLeft")} onClick={() => turn(-1)}><RotateCcw className="size-4" /></IconAction>
              <IconAction label={label("rotateRight")} onClick={() => turn(1)}><RotateCw className="size-4" /></IconAction>
              <IconAction label={label("flipH")} pressed={draft.flipH} onClick={() => setDraft((d) => ({ ...d, flipH: !d.flipH }))}>
                <FlipHorizontal className="size-4" />
              </IconAction>
              <IconAction label={label("flipV")} pressed={draft.flipV} onClick={() => setDraft((d) => ({ ...d, flipV: !d.flipV }))}>
                <FlipVertical className="size-4" />
              </IconAction>
            </div>
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDraft((d) => ({ ...d, crop: FULL_CROP, rotate: 0, flipH: false, flipV: false }))}
          >
            <Undo2 className="size-3.5" /> {label("resetFraming")}
          </Button>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>{t("common:action.cancel")}</Button>
            <Button size="sm" onClick={apply}>{label("applyFraming")}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IconAction({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="sm" variant={pressed ? "default" : "outline"} onClick={onClick} aria-pressed={pressed}>
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
