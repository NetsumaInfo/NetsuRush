import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScanFace, ImagePlus, Check, UserPlus, Users, Search, RefreshCw, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { type GalleryFace, type CharRef } from "@/lib/bridge";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
} from "@/components/ui/context-menu";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { FaceModelsBanner } from "@/components/search/FaceModelsBanner";
import { cn } from "@/lib/utils";
import { SelectToggle } from "@/components/common/selectable";

const faceKey = (f: GalleryFace) => `${f.ref.file_path}#${f.ref.scene_index}#${f.ref.face_index}#${f.domain}`;
const toRef = (f: GalleryFace): CharRef => ({
  file_path: f.ref.file_path, scene_index: f.ref.scene_index, face_index: f.ref.face_index,
  domain: f.ref.domain,   // un plan peut avoir un visage animé ET réel au même face_index
});

// Carte d'un visage détecté. Clic = chercher (ou (dé)cocher si une sélection est en cours). La case
// (coin) est le point d'entrée du mode multi : cocher une carte fait apparaître les cases partout.
function GalleryCardImpl({ f, anySel, selected, onSearch, onToggle, onCreateOne, onAddTo }: {
  f: GalleryFace; anySel: boolean; selected: boolean;
  onSearch: () => void; onToggle: () => void; onCreateOne: () => void; onAddTo: (charId: number) => void;
}) {
  const { t } = useTranslation("search");
  const characters = useApp((s) => s.characters);
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <button type="button"
          onClick={anySel ? onToggle : onSearch}
          className={cn(
            "group relative block aspect-square w-full overflow-hidden rounded-lg border bg-muted transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary",
            selected ? "border-primary ring-2 ring-primary" : "border-border hover:border-primary",
          )}>
          {f.thumb
            ? <img src={f.thumb} alt="" className="h-full w-full object-cover" />
            : <div className="flex h-full items-center justify-center text-muted-foreground"><ScanFace className="h-8 w-8 opacity-40" /></div>}
          <span className="absolute right-1 top-1 rounded bg-black/70 px-1 text-[10px] tabular-nums text-white/90">{f.count}</span>
          {f.char ? (
            <span className="absolute inset-x-0 bottom-0 truncate px-1.5 py-1 text-center text-xs font-semibold text-white"
              style={{ background: f.char.color || "rgba(0,0,0,.72)" }}>{f.char.name}</span>
          ) : (
            <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 py-px text-[9px] leading-none text-white/70">
              {f.domain === "anime" ? t("domain.anime") : t("domain.real")}
            </span>
          )}
          <SelectToggle
            selected={selected}
            onToggle={onToggle}
            className={cn("left-1 top-1 right-auto", anySel && !selected && "opacity-100")}
          />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onSearch}><Search /> {t("galleryPanel.card.search")}</ContextMenuItem>
        <ContextMenuItem onClick={onToggle}><Check /> {selected ? t("galleryPanel.card.deselect") : t("galleryPanel.card.select")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onCreateOne}><UserPlus /> {t("galleryPanel.card.newCharacter")}</ContextMenuItem>
        {characters.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger><Users /> {t("galleryPanel.card.addTo")}</ContextMenuSubTrigger>
            <ContextMenuSubContent className="max-h-64 overflow-y-auto">
              {characters.map((c) => (
                <ContextMenuItem key={c.id} onClick={() => onAddTo(c.id)} className="gap-2">
                  <span className="h-5 w-5 shrink-0 overflow-hidden rounded bg-muted">
                    {c.avatar ? <img src={c.avatar} alt="" className="h-full w-full object-cover" /> : <ScanFace className="m-0.5 h-4 w-4 text-muted-foreground" />}
                  </span>
                  <span className="truncate">{c.name}</span>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Mémoïsé : un toggle re-rend la grille entière, or chaque carte porte un menu contextuel complet.
// Les callbacks (recréés à chaque rendu, clos sur `f` stable ou setState fonctionnel) sont ignorés.
const GalleryCard = memo(GalleryCardImpl, (a, b) =>
  a.f === b.f && a.anySel === b.anySel && a.selected === b.selected);

// Onglet « Détectés » : grille des visages indexés. Cocher des cartes → « Créer » fait un personnage
// avec CES visages (ou « Ajouter à… » les verse dans un existant), en un geste.
export function GalleryPanel() {
  const { t } = useTranslation(["search", "common"]);
  const { faceGallery, faceGalleryLoading, searchByIndexedFace, refreshFaceGallery, closeFaceHub, openFacePicker,
    characters, createCharacterFromFaces, addFacesToCharacter, addSampleToCharacter } =
    useApp(useShallow((s) => ({
      faceGallery: s.faceGallery, faceGalleryLoading: s.faceGalleryLoading, searchByIndexedFace: s.searchByIndexedFace,
      refreshFaceGallery: s.refreshFaceGallery, closeFaceHub: s.closeFaceHub, openFacePicker: s.openFacePicker,
      characters: s.characters, createCharacterFromFaces: s.createCharacterFromFaces,
      addFacesToCharacter: s.addFacesToCharacter, addSampleToCharacter: s.addSampleToCharacter,
    })));

  const [sel, setSel] = useState<Set<string>>(new Set());
  const [naming, setNaming] = useState<CharRef[] | null>(null);   // visages en attente de nom (création)
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const gallery = faceGallery ?? [];
  const anySel = sel.size > 0;
  const selectedFaces = gallery.filter((f) => sel.has(faceKey(f)));
  const toggle = (f: GalleryFace) => setSel((s) => { const n = new Set(s); const k = faceKey(f); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const clearSel = () => setSel(new Set());

  function askName(refs: CharRef[]) { setName(""); setNaming(refs); }
  async function confirmCreate() {
    const n = name.trim();
    if (!n || !naming) return;
    setBusy(true);
    try { await createCharacterFromFaces(n, naming); }
    finally { setBusy(false); setNaming(null); clearSel(); }
  }
  async function addSelectedTo(charId: number) {
    setBusy(true);
    try { await addFacesToCharacter(charId, selectedFaces.map(toRef)); }
    finally { setBusy(false); clearSel(); }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Barre : icônes au repos ; en sélection → Créer / Ajouter à… / fermer, sur la même ligne. */}
      <div className="flex h-8 items-center gap-1.5">
        {anySel ? (
          <>
            <span className="text-sm font-medium tabular-nums">{sel.size}</span>
            <div className="flex-1" />
            <Button size="sm" disabled={busy} onClick={() => askName(selectedFaces.map(toRef))}>
              <UserPlus className="h-3.5 w-3.5" /> {t("galleryPanel.create")}
            </Button>
            {characters.length > 0 && (
              <AddToExistingMenu characters={characters} onPick={addSelectedTo} disabled={busy} />
            )}
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("galleryPanel.cancelSelectionAria")} onClick={clearSel} />}>
                <X className="h-4 w-4" />
              </TooltipTrigger>
              <TooltipContent>{t("galleryPanel.cancelTooltip")}</TooltipContent>
            </Tooltip>
          </>
        ) : (
          <>
            <div className="flex-1" />
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("galleryPanel.reloadAria")} onClick={refreshFaceGallery} disabled={faceGalleryLoading} />}>
                <RefreshCw className={cn("h-4 w-4", faceGalleryLoading && "animate-spin")} />
              </TooltipTrigger>
              <TooltipContent>{t("galleryPanel.reloadTooltip")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={<Button variant="outline" size="icon-sm" aria-label={t("galleryPanel.searchByPhotoAria")} onClick={() => { closeFaceHub(); openFacePicker(); }} />}>
                <ImagePlus className="h-4 w-4" />
              </TooltipTrigger>
              <TooltipContent>{t("galleryPanel.searchByPhotoTooltip")}</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>

      <FaceModelsBanner />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {faceGalleryLoading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" /> {t("galleryPanel.grouping")}</div>
        ) : gallery.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <ScanFace className="h-9 w-9 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{t("galleryPanel.empty")}</span>
          </div>
        ) : (
          <div className="grid gap-2.5 p-0.5 [grid-template-columns:repeat(auto-fill,minmax(120px,1fr))]">
            {gallery.map((f) => (
              <GalleryCard key={faceKey(f)} f={f} anySel={anySel} selected={sel.has(faceKey(f))}
                onSearch={() => searchByIndexedFace(f.ref)}
                onToggle={() => toggle(f)}
                onCreateOne={() => askName([toRef(f)])}
                onAddTo={(charId) => void addSampleToCharacter(charId, toRef(f))} />
            ))}
          </div>
        )}
      </div>

      <Dialog open={naming != null} onOpenChange={(o) => { if (!o) setNaming(null); }}>
        <DialogContent className="max-w-sm">
          <DialogTitle>{naming && naming.length > 1 ? t("galleryPanel.multiCharacterTitle", { count: naming.length }) : t("galleryPanel.newCharacterTitle")}</DialogTitle>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("galleryPanel.namePlaceholder")}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void confirmCreate(); }} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setNaming(null)}>{t("common:action.cancel")}</Button>
            <Button size="sm" disabled={!name.trim() || busy} onClick={confirmCreate}>
              {busy ? <Spinner className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />} {t("galleryPanel.create")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Menu « Ajouter à un personnage existant » (clic gauche).
function AddToExistingMenu({ characters, onPick, disabled }: {
  characters: { id: number; name: string; avatar: string | null }[]; onPick: (id: number) => void; disabled?: boolean;
}) {
  const { t } = useTranslation("search");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={disabled} />}>
        <Users className="h-3.5 w-3.5" /> {t("galleryPanel.card.addTo")}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto">
        {characters.map((c) => (
          <DropdownMenuItem key={c.id} onClick={() => onPick(c.id)} className="gap-2">
            <span className="h-5 w-5 shrink-0 overflow-hidden rounded bg-muted">
              {c.avatar ? <img src={c.avatar} alt="" className="h-full w-full object-cover" /> : <ScanFace className="m-0.5 h-4 w-4 text-muted-foreground" />}
            </span>
            <span className="truncate">{c.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
