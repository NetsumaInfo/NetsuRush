// Sélecteur d'icône d'un profil d'export, façon Carnet — 3 onglets : Emojis (emoji-mart), Icônes
// (grille lucide cherchable, jeu complet), Images (bibliothèque persistée + import GIF/PNG). Popover
// Base UI. Renvoie un ExportIcon ({ emoji } | { lucide } | { image }).
import { createElement, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@base-ui/react/popover";
import type { LucideIcon } from "lucide-react";
import { Smile, Shapes, Images as ImagesIcon, Search, ImagePlus, X, Loader2 } from "lucide-react";
import { lucideIcon, lucideNames, loadLucideCatalog, useLucideCatalog } from "@/lib/lucideCatalog";
import { useApp } from "@/store";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { EmojiPicker } from "@/components/common/EmojiPicker";
import { HoverLabel } from "@/components/common/HoverLabel";
import type { ExportProfile, ExportIcon } from "@/features/export/profiles";
import { ExportProfileIcon, fileToIconDataUrl } from "./exportIcons";

type Tab = "emoji" | "icon" | "image";

function IconTab({ current, onPick }: { current: string | null; onPick: (icon: ExportIcon) => void }) {
  const { t } = useTranslation("export");
  // Grille du jeu COMPLET : le catalogue arrive dans un chunk asynchrone (cf. lib/lucideCatalog).
  useLucideCatalog();
  const names = lucideNames();
  const [q, setQ] = useState("");
  // Une seule bulle pour toute la grille (cf. common/HoverLabel) : un Tooltip par cellule coûtait
  // 240 stores de positionnement et rendait l'onglet lent à ouvrir.
  const gridRef = useRef<HTMLDivElement>(null);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? names.filter((n) => n.toLowerCase().includes(s)) : names).slice(0, 240);
  }, [q, names]);
  return (
    <div className="flex flex-col">
      <div className="mb-2 flex items-center gap-1.5">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("iconPicker.search")} className="flex-1 h-7 border-0" />
      </div>
      {names.length === 0 ? (
        <div className="flex h-64 items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> {t("iconPicker.loading")}
        </div>
      ) : (
        <>
          <div ref={gridRef} className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto">
            {list.map((n) => (
              <button key={n} type="button" aria-label={n} data-hover-label={n} onClick={() => onPick({ type: "lucide", name: n })}
                className={cn("flex aspect-square items-center justify-center rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  current === n ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
                {createElement(lucideIcon(n) as LucideIcon, { className: "h-4 w-4" })}
              </button>
            ))}
          </div>
          <HoverLabel containerRef={gridRef} />
        </>
      )}
    </div>
  );
}

function ImageTab({ current, onPick }: { current: string | null; onPick: (icon: ExportIcon) => void }) {
  const { t } = useTranslation("export");
  const fileRef = useRef<HTMLInputElement>(null);
  const library = useApp((s) => s.iconLibrary);
  const addIcon = useApp((s) => s.addIconToLibrary);
  const removeIcon = useApp((s) => s.removeIconFromLibrary);
  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    const src = await fileToIconDataUrl(file);
    addIcon(src);
    onPick({ type: "image", src });
  };
  return (
    <div>
      {library.length > 0 && (
        // Vignettes larges et `object-contain` : un logo à fond transparent doit se lire entier,
        // un recadrage carré lui mangeait les bords.
        <div className="mb-2 grid grid-cols-5 gap-1.5">
          {library.map((src) => (
            <div key={src} className="group/icn relative">
              <button type="button" aria-label={t("iconPicker.importedImage")} onClick={() => onPick({ type: "image", src })}
                className={cn("flex aspect-square w-full items-center justify-center overflow-hidden rounded-md border bg-muted/40 p-1 transition-colors",
                  current === src ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground/40")}>
                <img src={src} alt="" className="max-h-full max-w-full object-contain" draggable={false} />
              </button>
              <button type="button" aria-label={t("iconPicker.removeFromLibrary")} onClick={() => removeIcon(src)}
                className="absolute -right-1 -top-1 hidden size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground group-hover/icn:flex">
                <X className="size-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <button type="button" onClick={() => fileRef.current?.click()}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-2 py-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
        <ImagePlus className="size-4" /> {t("iconPicker.importImage")}
      </button>
      <input ref={fileRef} type="file" accept="image/*,image/gif" className="hidden"
        onChange={(e) => void pickFile(e.target.files?.[0])
          .catch(() => {})
          .finally(() => { if (fileRef.current) fileRef.current.value = ""; })} />
    </div>
  );
}

export function IconPicker({ profile, onChange }: { profile: ExportProfile; onChange: (icon: ExportIcon) => void }) {
  const { t } = useTranslation("export");
  const [tab, setTab] = useState<Tab>("icon");
  const currentName = profile.icon?.type === "lucide" ? profile.icon.name : null;
  const currentImage = profile.icon?.type === "image" ? profile.icon.src : null;
  const tabs: { id: Tab; label: string; icon: LucideIcon }[] = [
    { id: "emoji", label: t("iconPicker.tabEmojis"), icon: Smile },
    { id: "icon", label: t("iconPicker.tabIcons"), icon: Shapes },
    { id: "image", label: t("iconPicker.tabImages"), icon: ImagesIcon },
  ];

  return (
    // Le catalogue lucide (chunk de 1 700 modules) est préchauffé dès l'ouverture du popover, pas au
    // montage de l'onglet : sinon le premier clic sur « Icônes » attend le réseau devant une grille vide.
    <Popover.Root onOpenChange={(open) => { if (open) loadLucideCatalog(); }}>
      <Popover.Trigger
        aria-label={t("iconPicker.profileIcon")}
        className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-card text-foreground outline-none transition hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary data-[popup-open]:ring-2 data-[popup-open]:ring-primary"
      >
        <ExportProfileIcon profile={profile} className="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50 outline-none">
          <Popover.Popup className="w-[22rem] origin-[var(--transform-origin)] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl outline-none data-[starting-style]:scale-98 data-[starting-style]:opacity-0 transition-[transform,opacity]">
            <div className="mb-2 flex items-center gap-1 border-b border-border pb-2">
              {tabs.map((t) => (
                <button key={t.id} type="button" onClick={() => setTab(t.id)}
                  className={cn("flex items-center gap-1 rounded-md px-2 py-1 text-sm", tab === t.id ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>
                  {createElement(t.icon, { className: "h-3.5 w-3.5" })} {t.label}
                </button>
              ))}
            </div>
            {tab === "emoji" && <EmojiPicker onPick={(ch) => onChange({ type: "emoji", ch })} />}
            {tab === "icon" && <IconTab current={currentName} onPick={onChange} />}
            {tab === "image" && <ImageTab current={currentImage} onPick={onChange} />}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
