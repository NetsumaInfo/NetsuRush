// Sous-panneaux de l'inspecteur : portée de boucle (vidéo/YouTube), texte, cadre, barre d'arrangement.
import {
  Trash2, Bold, Italic, Underline, Strikethrough, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  List, ListOrdered, Indent, Outdent, Link2, Link2Off, RemoveFormatting, ExternalLink, FileSymlink, Crosshair,
  Crop, PaintBucket, Film, Package,
  SquareDashed, SquareDot, ArrowRight, Repeat, Repeat2, Snowflake,
  AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter, LayoutGrid, MoreHorizontal,
  Wand2, Palette, RotateCcw, Magnet,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { Popover } from "@base-ui/react/popover";
import NumberFlow from "@number-flow/react";
import { nr, type NetsuLevel } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuGroup,
  DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useBoard, type ArrangeMode } from "./useReferenceBoard";
import { FONT_FAMILIES, HANDWRITING_FONT, EMBED_LEVELS, type BoardItem, type BoardLink } from "./referenceShared";
import { playerSeek, playerTime } from "./playhead";
import { IconToggle, IconAction, ColorControl, MiniSelect, FontPicker, NumberSpin } from "./inspectorControls";
import { Button } from "@/components/ui/button";
import { TidyMenu } from "./TidyMenu";
import { extractPaletteToBoard } from "./boardPaletteActions";

// Écart repris en quittant le mode collé (le défaut du sélecteur de rangement).
const DEFAULT_TIDY_GAP = 16;

// Libellés des modes de lecture (résolus au rendu via i18n).
const PLAY_KEY: Record<PlayMode, string> = {
  loop: "playMode.loop", pingpong: "playMode.pingpong", off: "playMode.off",
};

// Champ nombre « blanc » : pastille claire, valeur lisible, saisie précise (commit au blur/Entrée).
function TrimNum({ value, empty, placeholder, ariaLabel, onCommit }: {
  value: number; empty?: boolean; placeholder?: string; ariaLabel: string; onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (empty ? "" : String(Number(value.toFixed(1))));
  return (
    <input
      type="number" inputMode="decimal" step={0.1} min={0}
      aria-label={ariaLabel} placeholder={placeholder} value={shown}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft != null) { const v = parseFloat(draft); onCommit(isNaN(v) ? 0 : Math.max(0, v)); setDraft(null); } }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      className="h-7 w-12 rounded-md border border-border bg-foreground/10 px-1.5 text-center text-xs font-semibold tabular-nums text-foreground outline-none transition-colors focus:border-primary focus:bg-foreground/[0.16] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    />
  );
}

// Playhead drawn over the loop slider: the position is polled straight from the player (never routed
// through the store — it moves too often), so one can see WHERE the loop is playing. A backward jump
// means the loop just restarted → the bar flashes, which is the only visible cue of a restart on a
// short range.
const HEAD_POLL_MS = 60;
const RESTART_JUMP_S = 0.15;
// Diamètre du pouce du curseur (`size-4`). Base UI, en `thumbAlignment="edge"`, ne place PAS le pouce
// linéairement : il le rentre d'un demi-pouce à chaque bout pour qu'il ne déborde jamais de la piste,
// soit `pouce/2 + (largeur − pouce) × pct`. La tête de lecture doit suivre la même règle, sinon elle
// ne coïncide avec les bornes qu'au milieu de la course et paraît dépasser la fin.
const THUMB_PX = 16;
// Cadence maximale des aperçus de scrub. Un lecteur ne suit pas un événement de curseur par pixel.
const SCRUB_MS = 90;

function LoopPlayhead({ id, span }: { id: string; span: number }) {
  const [pos, setPos] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const prev = useRef<number | null>(null);
  useEffect(() => {
    let off: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      const now = playerTime(id);
      setPos(now);
      if (now != null && prev.current != null && now < prev.current - RESTART_JUMP_S) {
        setFlash(true);
        clearTimeout(off);
        off = setTimeout(() => setFlash(false), 220);
      }
      prev.current = now;
    }, HEAD_POLL_MS);
    return () => { clearInterval(timer); clearTimeout(off); };
  }, [id]);

  if (pos == null || !span) return null;
  const pct = Math.min(100, Math.max(0, (pos / span) * 100));
  return (
    <>
      <span
        className={cn(
          "pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary transition-opacity",
          flash ? "opacity-70 duration-0" : "opacity-0 duration-300",
        )}
      />
      <span
        className="pointer-events-none absolute top-1/2 z-10 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow ring-1 ring-black/40"
        style={{ left: `calc(${THUMB_PX / 2}px + (100% - ${THUMB_PX}px) * ${pct / 100})` }}
      />
    </>
  );
}

// Portée de boucle — icônes + nombres. Dual-slider custom (pouces BLANCS + bulle chiffrée live pour
// la précision visuelle) ; pastilles nombre pour la saisie exacte ; icône ∞ = boucle entière.
export function TrimControls({ item }: { item: BoardItem }) {
  const { t } = useTranslation("reference");
  const patchItem = useBoard((s) => s.patchItem);
  const dur = item.dur && item.dur > 0 ? item.dur : null;
  const tin = item.trimIn && item.trimIn > 0 ? item.trimIn : 0;
  const tout = item.trimOut != null && item.trimOut > 0 ? item.trimOut : dur ?? 0;
  const hi = dur ? Math.min(tout || dur, dur) : tout;
  // Borne du curseur, arrondie AU-DESSUS de la durée : arrondie au plus proche elle pouvait tomber
  // SOUS `dur`, et la valeur de fin (= `dur` quand rien n'est rogné) sortait alors de la plage — le
  // pouce ne rejoignait plus le bout de la piste alors que le clip est lu en entier.
  const max = dur ? Math.ceil(dur * 10) / 10 : 0;
  // Dernière position visée par le geste + date du dernier aperçu demandé (cf. `onValueChange`).
  const scrub = useRef<{ at: number | null; last: number }>({ at: null, last: 0 });

  const set = (a: number, b: number) =>
    patchItem(item.id, {
      trimIn: a > 0.05 ? a : undefined,
      trimOut: dur && b < dur - 0.05 ? b : b > 0.05 && !dur ? b : undefined,
    });

  return (
    <div className="flex items-center gap-1.5">
      <TrimNum value={tin} ariaLabel={t("trim.start")} onCommit={(v) => set(v, hi)} />

      {dur ? (
        <SliderPrimitive.Root
          value={[tin, hi]} min={0} max={max} step={0.1} thumbAlignment="edge"
          onValueChange={(v) => {
            const a = Array.isArray(v) ? v : [0, dur];
            set(a[0], a[1]);
            // Scrub: the dragged bound previews on the media itself, so a range is set by what is
            // seen, not by reading numbers. Le curseur émet à chaque pixel parcouru : on garde la
            // dernière position voulue mais on n'en demande l'aperçu qu'à cadence tenable, en mode
            // « geste en cours » (aucun chargement réseau côté lecteur streamé).
            const moved = Math.abs(a[0] - tin) > 0.001 ? a[0] : Math.abs(a[1] - hi) > 0.001 ? a[1] : null;
            if (moved == null) return;
            scrub.current.at = moved;
            const now = Date.now();
            if (now - scrub.current.last < SCRUB_MS) return;
            scrub.current.last = now;
            playerSeek(item.id, moved, true);
          }}
          // Geste terminé : un dernier seek, chargement autorisé, pour montrer la VRAIE image de la
          // borne posée et non la dernière frame qui se trouvait déjà en tampon.
          onValueCommitted={() => {
            const { at } = scrub.current;
            scrub.current = { at: null, last: 0 };
            if (at != null) playerSeek(item.id, at);
          }}
          className="w-28"
        >
          <SliderPrimitive.Control className="relative flex w-full touch-none items-center py-2 select-none">
            <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-foreground/20 select-none">
              <SliderPrimitive.Indicator className="h-full bg-primary select-none" />
            </SliderPrimitive.Track>
            <LoopPlayhead id={item.id} span={max} />
            {[tin, hi].map((val, i) => (
              <SliderPrimitive.Thumb
                key={i}
                className="group/th relative block size-4 shrink-0 rounded-full border-2 border-primary bg-white shadow ring-primary/40 transition-[box-shadow] select-none hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden"
              >
                <NumberFlow
                  value={Number(val.toFixed(1))} suffix="s"
                  className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 rounded-md bg-popover px-1.5 py-0.5 text-[10px] font-semibold text-popover-foreground opacity-0 shadow ring-1 ring-foreground/10 transition-opacity group-hover/th:opacity-100 group-focus-visible/th:opacity-100"
                />
              </SliderPrimitive.Thumb>
            ))}
          </SliderPrimitive.Control>
        </SliderPrimitive.Root>
      ) : (
        <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
      )}

      <TrimNum
        value={hi} empty={item.trimOut == null} placeholder={dur ? dur.toFixed(1) : undefined}
        ariaLabel={t("trim.end")} onCommit={(v) => set(tin, v)}
      />
    </div>
  );
}

// Mode de lecture d'un item vidéo/YouTube — bouton-cycle (une icône qui change à chaque clic) :
// boucle infinie → aller-retour → figé → boucle. "Figé" ne joue jamais, même au Play global.
type PlayMode = NonNullable<BoardItem["playMode"]>;
const PLAY_ICON: Record<PlayMode, ComponentType> = {
  loop: Repeat, pingpong: Repeat2, off: Snowflake,
};
const PLAY_CYCLE: Record<PlayMode, PlayMode> = { loop: "pingpong", pingpong: "off", off: "loop" };

export function PlayModeControls({ item }: { item: BoardItem }) {
  const { t } = useTranslation("reference");
  const patchItem = useBoard((s) => s.patchItem);
  const mode: PlayMode = item.playMode ?? "loop";
  const Icon = PLAY_ICON[mode];
  return (
    <IconToggle
      on={mode !== "off"}
      label={t(PLAY_KEY[mode])}
      onClick={() => patchItem(item.id, { playMode: PLAY_CYCLE[mode] })}
    >
      <Icon />
    </IconToggle>
  );
}

// Paliers d'interligne (multiplicateur de line-height).
const LINE_HEIGHTS: { labelKey: string; v: number }[] = [
  { labelKey: "text.lhTight", v: 1 },
  { labelKey: "text.lhNormal", v: 1.2 },
  { labelKey: "text.lhComfortable", v: 1.5 },
  { labelKey: "text.lhWide", v: 1.9 },
];
const INDENT_MAX = 8;

// Retire le préfixe de liste (« • » ou « n. ») d'une ligne.
const stripListPrefix = (l: string) => l.replace(/^•\s?/, "").replace(/^\d+\.\s?/, "");

// Bascule une liste à puces dans le TEXTE même de la note (modèle plain-text → la puce est un
// caractère réel, persiste tel quel). Ajoute/retire « • » en tête de chaque ligne non vide.
// Exclusif de la liste numérotée (le préfixe de l'autre mode est retiré au passage).
function toggleBullet(item: BoardItem, patch: (p: Partial<BoardItem>) => void) {
  const on = !item.bullet;
  const next = (item.text ?? "")
    .split("\n")
    .map((l) => {
      const bare = stripListPrefix(l);
      return on && bare.trim() ? `• ${bare}` : bare;
    })
    .join("\n");
  patch({ bullet: on, numbered: undefined, text: next });
}

// Liste numérotée : mêmes principes que toggleBullet — « 1. 2. 3. » écrits dans le texte,
// numérotation continue sur les lignes non vides.
function toggleNumbered(item: BoardItem, patch: (p: Partial<BoardItem>) => void) {
  const on = !item.numbered;
  let n = 0;
  const next = (item.text ?? "")
    .split("\n")
    .map((l) => {
      const bare = stripListPrefix(l);
      return on && bare.trim() ? `${++n}. ${bare}` : bare;
    })
    .join("\n");
  patch({ numbered: on, bullet: undefined, text: next });
}

// Préréglages de style de bloc (taille + graisse d'un coup, façon Titre/Sous-titre/Corps).
const TEXT_PRESETS: { labelKey: string; fontSize: number; bold: boolean }[] = [
  { labelKey: "text.presetTitle", fontSize: 44, bold: true },
  { labelKey: "text.presetSubtitle", fontSize: 34, bold: true },
  { labelKey: "text.presetBody", fontSize: 28, bold: false },
];

// Réinitialise tout le formatage de la note (conserve texte, géométrie, lien).
function clearFormatting(patch: (p: Partial<BoardItem>) => void) {
  patch({
    bold: undefined, italic: undefined, underline: undefined, strike: undefined,
    highlight: undefined, lineHeight: undefined, indent: undefined, bullet: undefined, numbered: undefined,
    align: "left", color: "#ffffff", bg: "transparent",
    fontFamily: HANDWRITING_FONT, fontSize: 28,
  });
}

// Pose/ouvre un lien sur une note : URL web (navigateur), fichier local (app système), ou item du
// board (recadre la caméra dessus). Popover de configuration ; clic gauche du trigger l'ouvre.
function LinkControl({ item }: { item: BoardItem }) {
  const { t } = useTranslation("reference");
  const patchItem = useBoard((s) => s.patchItem);
  const requestFocus = useBoard((s) => s.requestFocus);
  const items = useBoard((s) => s.items);
  const [kind, setKind] = useState<BoardLink["kind"]>(item.link?.kind ?? "url");
  const link = item.link;

  const setLink = (target: string) =>
    patchItem(item.id, { link: target ? { kind, target } : undefined });
  const linkItems = items.filter((i) => i.id !== item.id && i.kind !== "draw");
  const labelFor = (i: BoardItem) =>
    (i.text || i.title || i.kind) + (i.kind === "text" ? "" : ` · ${i.kind}`);

  const KINDS: { k: BoardLink["kind"]; icon: ComponentType; label: string }[] = [
    { k: "url", icon: ExternalLink, label: t("link.kindUrl") },
    { k: "file", icon: FileSymlink, label: t("link.kindFile") },
    { k: "item", icon: Crosshair, label: t("link.kindItem") },
  ];

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={t("link.label")}
        className={cn("inline-flex size-8 items-center justify-center rounded-md outline-none transition-colors hover:bg-foreground/10 data-[popup-open]:bg-foreground/10 [&_svg]:size-4", link ? "text-primary" : "text-foreground")}
      >
        <Link2 />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={8} className="z-50 outline-none">
          <Popover.Popup className="w-64 origin-[var(--transform-origin)] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl outline-none data-[starting-style]:scale-98 data-[starting-style]:opacity-0 transition-[transform,opacity]">
            <div className="mb-2 grid grid-cols-3 gap-1">
              {KINDS.map(({ k, icon: Icon, label }) => (
                <button type="button"
                  key={k}
                  onClick={() => setKind(k)}
                  className={`flex flex-col items-center gap-1 rounded-md py-1.5 text-[10px] transition-colors ${kind === k ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-foreground/5"}`}
                >
                  <Icon />
                  {label}
                </button>
              ))}
            </div>

            {kind === "url" && (
              <label className="block">
                <span className="sr-only">{t("link.kindUrl")}</span>
                <input
                  value={link?.kind === "url" ? link.target : ""}
                  placeholder="https://…"
                  onChange={(e) => setLink(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
                />
              </label>
            )}
            {kind === "file" && (
              <button type="button"
                onClick={async () => { const f = await nr.chooseAnyFile(); if (f) setLink(f); }}
                className="flex h-8 w-full items-center gap-2 truncate rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none hover:border-primary"
              >
                <FileSymlink className="size-3.5 shrink-0 opacity-70" />
                <span className="truncate">{link?.kind === "file" ? link.target : t("link.chooseFile")}</span>
              </button>
            )}
            {kind === "item" && (
              <MiniSelect
                ariaLabel={t("link.targetItem")} className="w-full"
                value={link?.kind === "item" ? link.target : ""}
                onChange={(v) => setLink(v)}
                items={linkItems.map((i) => ({ value: i.id, label: labelFor(i) }))}
              />
            )}

            {link && (
              <div className="mt-2 flex items-center gap-1">
                <button type="button"
                  onClick={() => {
                    if (link.kind === "url") void nr.openExternal(link.target);
                    else if (link.kind === "file") void nr.openPath(link.target);
                    else requestFocus(link.target);
                  }}
                  className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                >
                  <ExternalLink className="size-3.5" /> {t("common:action.open")}
                </button>
                <IconAction label={t("link.remove")} onClick={() => patchItem(item.id, { link: undefined })}>
                  <Link2Off className="text-destructive" />
                </IconAction>
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Contrôles d'édition de texte (police système, taille précise, styles, listes, alignement, interligne,
// indentation, couleurs, lien, effacer le formatage). Style appliqué à TOUTE la note (niveau bloc).
// Ce que le fichier .netsu gardera de CE média, quand le réglage du board ne convient pas : une
// référence clé qu'on veut en pleine qualité, ou un rush de 2 h qu'on ne veut qu'en lien. Le niveau
// vit sur l'item (BoardItem.embed) ; « Par défaut » l'efface et rend la main aux réglages du board.
export function EmbedControls({ item }: { item: BoardItem }) {
  const { t } = useTranslation("reference");
  const patchItem = useBoard((s) => s.patchItem);
  const boardLevel = useBoard((s) => s.prefs.embedLevel);
  const current = item.embed?.level;
  const label = current ? t(`embed.level.${current}`) : t("embed.useDefault");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<IconAction label={t("embed.itemLabel", { level: label })} onClick={() => {}}><Package /></IconAction>}
      />
      <DropdownMenuContent align="center" side="top" className="w-64">
        <DropdownMenuLabel>{t("embed.itemTitle")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current ?? "default"}
          onValueChange={(v) =>
            patchItem(item.id, { embed: v === "default" ? undefined : { ...item.embed, level: v as NetsuLevel } })
          }
        >
          <DropdownMenuRadioItem value="default">
            {t("embed.useDefault")} — {t(`embed.level.${boardLevel}`)}
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {EMBED_LEVELS.map((lv) => (
            <DropdownMenuRadioItem key={lv} value={lv}>{t(`embed.level.${lv}`)}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TextControls({ item }: { item: BoardItem }) {
  const { t } = useTranslation("reference");
  const patchItem = useBoard((s) => s.patchItem);
  const patch = (p: Partial<BoardItem>) => patchItem(item.id, p);
  const lh = item.lineHeight ?? 1.2;
  const indent = item.indent ?? 0;
  return (
    <>
      <FontPicker value={item.fontFamily ?? FONT_FAMILIES[0].value} onChange={(v) => patch({ fontFamily: v })} />
      <NumberSpin value={item.fontSize ?? 18} ariaLabel={t("text.fontSize")} onCommit={(v) => patch({ fontSize: v })} />
      <Separator orientation="vertical" className="h-6" />
      <IconToggle on={item.bold} label={t("text.bold")} onClick={() => patch({ bold: !item.bold })}><Bold /></IconToggle>
      <IconToggle on={item.italic} label={t("text.italic")} onClick={() => patch({ italic: !item.italic })}><Italic /></IconToggle>
      <IconToggle on={item.underline} label={t("text.underline")} onClick={() => patch({ underline: !item.underline })}><Underline /></IconToggle>
      <IconToggle on={item.strike} label={t("text.strike")} onClick={() => patch({ strike: !item.strike })}><Strikethrough /></IconToggle>
      <Separator orientation="vertical" className="h-6" />
      <IconToggle on={item.bullet} label={t("text.bullet")} onClick={() => toggleBullet(item, patch)}><List /></IconToggle>
      <IconToggle on={item.numbered} label={t("text.numbered")} onClick={() => toggleNumbered(item, patch)}><ListOrdered /></IconToggle>
      <IconAction label={t("text.outdent")} onClick={() => patch({ indent: Math.max(0, indent - 1) })}><Outdent /></IconAction>
      <IconAction label={t("text.indent")} onClick={() => patch({ indent: Math.min(INDENT_MAX, indent + 1) })}><Indent /></IconAction>
      <Separator orientation="vertical" className="h-6" />
      <IconToggle on={item.align === "left" || !item.align} label={t("text.alignLeft")} onClick={() => patch({ align: "left" })}><AlignLeft /></IconToggle>
      <IconToggle on={item.align === "center"} label={t("text.alignCenter")} onClick={() => patch({ align: "center" })}><AlignCenter /></IconToggle>
      <IconToggle on={item.align === "right"} label={t("text.alignRight")} onClick={() => patch({ align: "right" })}><AlignRight /></IconToggle>
      <IconToggle on={item.align === "justify"} label={t("text.alignJustify")} onClick={() => patch({ align: "justify" })}><AlignJustify /></IconToggle>
      <Separator orientation="vertical" className="h-6" />
      <ColorControl label={t("text.color")} value={item.color ?? "#ffffff"} onChange={(c) => patch({ color: c })} />
      <ColorControl label={t("text.highlight")} value={item.highlight ?? "transparent"} onChange={(c) => patch({ highlight: c })} allowTransparent />
      <ColorControl label={t("text.noteBg")} value={item.bg ?? "transparent"} onChange={(c) => patch({ bg: c })} allowTransparent />
      <Separator orientation="vertical" className="h-6" />
      <LinkControl item={item} />
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("text.more")}
          className="inline-flex size-8 items-center justify-center rounded-md text-foreground outline-none transition-colors hover:bg-foreground/10 data-[popup-open]:bg-foreground/10 [&_svg]:size-4"
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-52">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("text.style")}</DropdownMenuLabel>
            {TEXT_PRESETS.map((p) => (
              <DropdownMenuItem key={p.labelKey} onClick={() => patch({ fontSize: p.fontSize, bold: p.bold || undefined })}>
                <span style={{ fontWeight: p.bold ? 700 : 400 }}>{t(p.labelKey)}</span>
                <span className="ml-auto text-xs text-muted-foreground">{p.fontSize}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("text.lineHeight")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={String(lh)} onValueChange={(v) => patch({ lineHeight: parseFloat(v) })}>
              {LINE_HEIGHTS.map((o) => (
                <DropdownMenuRadioItem key={o.v} value={String(o.v)}>{t(o.labelKey)}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => clearFormatting(patch)}>
            <RemoveFormatting /> {t("text.clearFormat")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

// Remplissage du cadre : cycle contour-seul → aplat léger → plein (icône qui change à chaque clic).
const FILL_CYCLE: Record<NonNullable<BoardItem["fillMode"]>, NonNullable<BoardItem["fillMode"]>> = {
  none: "tint", tint: "solid", solid: "none",
};
const FILL_META: Record<NonNullable<BoardItem["fillMode"]>, { icon: ComponentType; labelKey: string }> = {
  none: { icon: SquareDashed, labelKey: "frame.fillNone" },
  tint: { icon: SquareDot, labelKey: "frame.fillTint" },
  solid: { icon: PaintBucket, labelKey: "frame.fillSolid" },
};

// Cadre : titre, police + taille du titre, couleur du contour/titre, et mode de remplissage.
export function FrameControls({ item }: { item: BoardItem }) {
  const { t } = useTranslation("reference");
  const patchItem = useBoard((s) => s.patchItem);
  const fillMode = item.fillMode ?? (item.filled ? "solid" : "tint");
  const fill = FILL_META[fillMode];
  return (
    <>
      <input
        type="text"
        value={item.text ?? ""} placeholder={t("frame.titlePlaceholder")}
        onChange={(e) => patchItem(item.id, { text: e.target.value })}
        className="h-7 w-36 px-2 text-xs rounded border border-border bg-background text-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
      />
      <FontPicker value={item.fontFamily ?? FONT_FAMILIES[0].value} onChange={(v) => patchItem(item.id, { fontFamily: v })} />
      <NumberSpin value={item.fontSize ?? 14} ariaLabel={t("frame.titleSize")} onCommit={(v) => patchItem(item.id, { fontSize: v })} />
      <Separator orientation="vertical" className="h-6" />
      <ColorControl label={t("frame.borderColor")} value={item.color ?? "#60a5fa"} onChange={(c) => patchItem(item.id, { color: c })} />
      <ColorControl label={t("frame.titleBg")} value={item.titleBg ?? "var(--color-surface)"} onChange={(c) => patchItem(item.id, { titleBg: c })} allowTransparent />
      <IconToggle
        on={fillMode !== "none"}
        label={t(fill.labelKey)}
        onClick={() => patchItem(item.id, { fillMode: FILL_CYCLE[fillMode], filled: undefined })}
      >
        <fill.icon />
      </IconToggle>
      {fillMode === "solid" && (
        <ColorControl
          label={t("frame.fillColor")}
          value={item.fillColor ?? item.color ?? "#1f2937"}
          onChange={(c) => patchItem(item.id, { fillColor: c })}
        />
      )}
    </>
  );
}

const ARRANGE: { mode: ArrangeMode; labelKey: string; icon: typeof Crop }[] = [
  { mode: "left", labelKey: "arrange.left", icon: AlignHorizontalJustifyStart },
  { mode: "hcenter", labelKey: "arrange.hcenter", icon: AlignHorizontalJustifyCenter },
  { mode: "right", labelKey: "arrange.right", icon: AlignHorizontalJustifyEnd },
  { mode: "top", labelKey: "arrange.top", icon: AlignVerticalJustifyStart },
  { mode: "vcenter", labelKey: "arrange.vcenter", icon: AlignVerticalJustifyCenter },
  { mode: "bottom", labelKey: "arrange.bottom", icon: AlignVerticalJustifyEnd },
  { mode: "hdist", labelKey: "arrange.hdist", icon: AlignHorizontalDistributeCenter },
  { mode: "vdist", labelKey: "arrange.vdist", icon: AlignVerticalDistributeCenter },
  { mode: "grid", labelKey: "arrange.grid", icon: LayoutGrid },
];

export function ArrangeBar({ count }: { count: number }) {
  const { t } = useTranslation("reference");
  const arrange = useBoard((s) => s.arrange);
  const tidy = useBoard((s) => s.tidy);
  const setPrefs = useBoard((s) => s.setPrefs);
  const gap = useBoard((s) => s.prefs.arrangeGap);
  const removeSelected = useBoard((s) => s.removeSelected);
  const groupSequence = useBoard((s) => s.groupSequence);
  const reset = useBoard((s) => s.reset);
  const selectedIds = useBoard((s) => s.selectedIds);
  const items = useBoard((s) => s.items);
  // Groupable en séquence : ≥2 items sélectionnés, tous des images. Mémoïsé pour éviter le
  // scan O(n·m) à chaque snapshot du store (geste/pan) — recalculé seulement si la sélection change.
  const groupable = useMemo(
    () => selectedIds.length >= 2 && selectedIds.every((id) => items.find((i) => i.id === id)?.kind === "image"),
    [selectedIds, items],
  );
  return (
    <div className="flex items-center gap-1">
      <span className="mr-1 rounded bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground" aria-label={t("arrange.selectedCount", { count })}>{count}</span>
      {ARRANGE.map((a, i) => (
        <span key={a.mode} className="flex items-center">
          {(i === 3 || i === 6) && <Separator orientation="vertical" className="mx-1 h-6" />}
          <IconAction label={t(a.labelKey)} onClick={() => arrange(a.mode)}><a.icon /></IconAction>
        </span>
      ))}
      {groupable && (
        <>
          <Separator orientation="vertical" className="mx-1 h-6" />
          <IconAction label={t("arrange.groupSequence")} onClick={() => groupSequence(selectedIds)}><Film /></IconAction>
        </>
      )}

      <Separator orientation="vertical" className="mx-1 h-6" />
      {/* Ranger : disposition + uniformisation de taille, choisies dans le sélecteur, appliquées
          ensemble (une seule entrée d'annulation). */}
      <TidyMenu
        trigger={
          <Button variant="ghost" size="icon-sm" aria-label={t("tidy.title")}>
            <Wand2 />
          </Button>
        }
      />
      {/* Collé : à portée de clic DANS la barre de sélection, pas seulement au fond du sélecteur.
          C'est un aller-retour permanent quand on compose une planche — on veut voir tout de suite
          la même sélection serrée puis aérée. Bascule l'écart ET range aussitôt. */}
      <IconToggle
        on={gap === 0}
        label={gap === 0 ? t("tidy.gapSome") : t("tidy.gapNone")}
        onClick={() => {
          const p = useBoard.getState().prefs;
          const next = p.arrangeGap === 0 ? DEFAULT_TIDY_GAP : 0;
          setPrefs({ arrangeGap: next, ...(next === 0 ? { arrangeLayout: "block" as const } : {}) });
          tidy({
            layout: next === 0 ? "block" : p.arrangeLayout,
            uniform: p.arrangeUniform,
            gap: next,
            sort: p.arrangeSort,
          });
        }}
      >
        <Magnet />
      </IconToggle>
      <IconAction label={t("palette.extract")} onClick={() => void extractPaletteToBoard()}><Palette /></IconAction>
      <IconAction label={t("actions.resetAll")} onClick={() => reset("all")}><RotateCcw /></IconAction>

      <Separator orientation="vertical" className="h-6" />
      <IconAction label={t("arrange.deleteSelection")} onClick={removeSelected}>
        <Trash2 className="text-destructive" />
      </IconAction>
    </div>
  );
}
