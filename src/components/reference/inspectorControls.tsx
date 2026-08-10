// Petits contrôles réutilisables de l'inspecteur (boutons-icône, sélecteur de couleur, select).
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ColorPicker } from "@/components/ui/color-picker";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { NOTE_COLORS, FONT_FAMILIES, loadSystemFonts } from "./referenceShared";
import { useBoard } from "./useReferenceBoard";

const TEXT_COLORS = ["#1f2937", "#ffffff", "#ef4444", "#f59e0b", "#10b981", "#3b82f6"];

export function IconToggle({ on, onClick, label, children }: {
  on?: boolean; onClick: () => void; label: string; children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant={on ? "default" : "ghost"} size="icon-sm" aria-label={label} aria-pressed={on} onClick={onClick} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={12} collisionAvoidance={{ side: "none" }}>{label}</TooltipContent>
    </Tooltip>
  );
}

export function IconAction({ label, onClick, active, children }: {
  label: string; onClick: () => void; active?: boolean; children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant={active ? "default" : "ghost"} size="icon-sm" aria-label={label} onClick={onClick} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={12} collisionAvoidance={{ side: "none" }}>{label}</TooltipContent>
    </Tooltip>
  );
}

// Sélecteur de couleur étiqueté (infobulle) → DA unifiée partout sur la board.
export function ColorControl({ label, value, onChange, allowTransparent }: {
  label: string; value: string; onChange: (v: string) => void; allowTransparent?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <ColorPicker
          value={value}
          onChange={onChange}
          ariaLabel={label}
          allowTransparent={allowTransparent}
          presets={allowTransparent ? NOTE_COLORS : TEXT_COLORS}
        />
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={12} collisionAvoidance={{ side: "none" }}>{label}</TooltipContent>
    </Tooltip>
  );
}

// Saisie numérique précise : promue dans la couche UI partagée (les réglages du fond d'écran ont le
// même besoin). Ré-exportée ici pour que les appelants du board restent inchangés.
export { NumberSpin } from "@/components/ui/number-spin";

// Libellé lisible d'une famille (nom du preset si connu, sinon 1re famille de la valeur brute).
export function fontLabel(value: string, translate: (key: string) => string): string {
  const preset = FONT_FAMILIES.find((f) => f.value === value);
  return preset ? translate(preset.labelKey) : value.replace(/['"]/g, "").split(",")[0];
}

// Sélecteur de police RICHE : favoris épinglés + presets + TOUTES les polices système
// (queryLocalFonts), recherche, étoile pour mettre en favori, aperçu dans la fonte. Lazy 1re ouverture.
export function FontPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation("reference");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sysFonts, setSysFonts] = useState<string[]>([]);
  const favFonts = useBoard((s) => s.prefs.favFonts);
  const toggleFavFont = useBoard((s) => s.toggleFavFont);

  useEffect(() => {
    if (open && sysFonts.length === 0) void loadSystemFonts().then(setSysFonts);
  }, [open, sysFonts.length]);

  // Sections : Favoris (ordre d'ajout) · Standards (presets) · Système, filtrées par la recherche.
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (v: string) => !q || fontLabel(v, t).toLowerCase().includes(q);
    const favSet = new Set(favFonts);
    const presetVals = FONT_FAMILIES.map((f) => f.value);
    const fav = favFonts.filter(match);
    const presets = presetVals.filter((v) => !favSet.has(v) && match(v));
    const sys = sysFonts.filter((v) => !favSet.has(v) && !presetVals.includes(v) && match(v));
    return [
      { key: "fav", titleKey: "font.favorites", items: fav },
      { key: "std", titleKey: "font.standard", items: presets },
      { key: "sys", titleKey: "font.system", items: sys },
    ].filter((s) => s.items.length);
  }, [favFonts, sysFonts, query, t]);

  const empty = sections.length === 0;

  return (
    <Tooltip>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Popover.Trigger
            aria-label={t("font.label")}
            className="flex h-7 w-32 items-center justify-between gap-1 rounded-md border border-border bg-transparent px-2 text-xs text-foreground outline-none transition-colors hover:bg-foreground/5 focus-visible:border-primary data-[popup-open]:border-primary"
          >
            <span className="truncate" style={{ fontFamily: value }}>{fontLabel(value, t)}</span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          </Popover.Trigger>
        </TooltipTrigger>
        <Popover.Portal>
          <Popover.Positioner side="top" sideOffset={8} className="z-50 outline-none">
            <Popover.Popup className="w-64 origin-[var(--transform-origin)] rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-xl outline-none data-[starting-style]:scale-98 data-[starting-style]:opacity-0 transition-[transform,opacity]">
              <input
                value={query} placeholder={t("font.search")} aria-label={t("font.search")}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                className="mb-2 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
              />
              <div className="max-h-64 overflow-y-auto pr-1">
                {empty && <span className="block px-2 py-6 text-center text-xs text-muted-foreground">{t("font.none")}</span>}
                {sections.map((sec) => (
                  <div key={sec.key} className="mb-1 flex flex-col gap-0.5">
                    <span className="px-2 pt-1 text-[10px] font-medium text-muted-foreground">{t(sec.titleKey)}</span>
                    {sec.items.map((v) => {
                      const fav = favFonts.includes(v);
                      return (
                        <div
                          key={`${sec.key}-${v}`}
                          // PERF : content-visibility saute la mise en page/le CHARGEMENT de police des
                          // lignes hors écran → l'ouverture ne charge plus des centaines de fontes système
                          // d'un coup (elles se chargent au défilement). `contain-intrinsic-size` évite le
                          // saut de scrollbar. Corrige la lenteur d'ouverture du sélecteur de police.
                          style={{ contentVisibility: "auto", containIntrinsicSize: "0 34px" }}
                          className={cn(
                            "group flex w-full items-center gap-1 rounded-md pr-1 text-sm transition-colors hover:bg-foreground/10",
                            v === value && "bg-primary/15",
                          )}
                        >
                          <button type="button"
                            onClick={() => { onChange(v); setOpen(false); }}
                            className={cn("flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left", v === value && "text-primary")}
                            style={{ fontFamily: v }}
                          >
                            <span className="truncate">{fontLabel(v, t)}</span>
                            {v === value && <Check className="size-3.5 shrink-0 text-primary" />}
                          </button>
                          <button type="button"
                            aria-label={fav ? t("actions.removeFavorite") : t("actions.addFavorite")}
                            onClick={(e) => { e.stopPropagation(); toggleFavFont(v); }}
                            className={cn(
                              "inline-flex size-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-foreground/15 [&_svg]:size-3.5",
                              fav ? "text-primary opacity-100" : "text-muted-foreground opacity-0 group-hover:opacity-100",
                            )}
                          >
                            <Star className={fav ? "fill-current" : ""} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <TooltipContent side="top" sideOffset={12} collisionAvoidance={{ side: "none" }}>{t("font.label")}</TooltipContent>
    </Tooltip>
  );
}

// Sélecteur compact → shadcn Select (Base UI), même rôle que les autres contrôles de l'inspecteur.
export function MiniSelect({ value, onChange, items, className, ariaLabel }: {
  value: string | number;
  onChange: (v: string) => void;
  items: { label: string; value: string }[];
  className?: string;
  ariaLabel: string;
}) {
  return (
    <Select items={items} value={String(value)} onValueChange={(v) => onChange(String(v))}>
      <SelectTrigger size="sm" className={className} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((it) => (
          <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
