import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserPlus, Search, Film, Pencil, Trash2, ScanFace, Users, Check, X, Merge, Spline, CheckSquare, Images } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { nr, type Character, type CharSample } from "@/lib/bridge";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { ColorPicker } from "@/components/ui/color-picker";
import { FaceModelsBanner } from "@/components/search/FaceModelsBanner";
import { InlineRename } from "@/components/search/InlineRename";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { selectionRing, SelectToggle } from "@/components/common/selectable";

interface Draft { name: string; notes: string; tags: string; color: string; }
const EMPTY: Draft = { name: "", notes: "", tags: "", color: "" };
const toDraft = (c: Character): Draft => ({ name: c.name, notes: c.notes, tags: c.tags.join(", "), color: c.color });
const parseTags = (s: string) => s.split(",").map((t) => t.trim()).filter(Boolean);

function CharForm({ draft, setDraft, onSave, onCancel, saving }: {
  draft: Draft; setDraft: (d: Draft) => void; onSave: () => void; onCancel: () => void; saving?: boolean;
}) {
  const { t } = useTranslation(["search", "common"]);
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
      <div className="flex items-center gap-2">
        <ColorPicker value={draft.color || "#7c8cff"} onChange={(color) => setDraft({ ...draft, color })} ariaLabel={t("rosterPanel.colorLabel")} />
        <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("rosterPanel.namePlaceholder")} className="flex-1" autoFocus />
      </div>
      <Input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder={t("rosterPanel.tagsPlaceholder")} />
      <Textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder={t("rosterPanel.notesPlaceholder")} className="min-h-16" />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-3.5 w-3.5" /> {t("common:action.cancel")}</Button>
        <Button size="sm" disabled={!draft.name.trim() || saving} onClick={onSave}><Check className="h-3.5 w-3.5" /> {t("common:action.save")}</Button>
      </div>
    </div>
  );
}

// Visages enregistrés d'un personnage : vignettes + retrait à l'unité (nettoyer les visages qui
// n'ont rien à y faire). Chargé à l'ouverture ; le retrait recharge la bande + le roster (compteurs).
function SamplesStrip({ charId }: { charId: number }) {
  const { t } = useTranslation(["search", "common"]);
  const removeSample = useApp((s) => s.removeCharacterSample);
  const [samples, setSamples] = useState<CharSample[] | null>(null);
  const [err, setErr] = useState(false);
  // .catch : sans la route core (fenêtre pas redémarrée) la promesse rejette → sinon spinner figé.
  const load = () => { setErr(false); nr.charSamples(charId).then((r) => setSamples(r.samples ?? [])).catch(() => { setSamples([]); setErr(true); }); };
  useEffect(load, [charId]);
  if (samples == null) {
    return <div className="flex h-14 items-center gap-2 text-xs text-muted-foreground"><Spinner className="h-3.5 w-3.5" /> {t("common:status.loading")}</div>;
  }
  if (err) {
    return <div className="text-[11px] text-muted-foreground">{t("rosterPanel.samplesUnavailable")}</div>;
  }
  if (samples.length === 0) {
    return <div className="text-[11px] text-muted-foreground">{t("rosterPanel.samplesEmpty")}</div>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {samples.map((s) => (
        <div key={s.id} className="group/s relative h-14 w-14 overflow-hidden rounded-md border border-border bg-muted">
          {s.thumb
            ? <img src={s.thumb} alt="" className="h-full w-full object-cover" />
            : <div className="flex h-full items-center justify-center"><ScanFace className="h-5 w-5 text-muted-foreground" /></div>}
          <span className="absolute bottom-0 left-0 rounded-tr bg-black/55 px-1 text-[8px] leading-3 text-white/80">
            {s.domain === "anime" ? t("domain.anime") : t("domain.real")}
          </span>
          <Tooltip>
            <TooltipTrigger render={<button type="button" aria-label={t("rosterPanel.removeSampleAria")}
              onClick={(e) => {
                e.stopPropagation();
                void removeSample(s.id).then(load).catch(() => setErr(true));
              }}
              className="absolute right-0 top-0 hidden h-5 w-5 items-center justify-center rounded-bl bg-black/70 text-white hover:bg-destructive group-hover/s:flex" />}>
              <X className="h-3 w-3" />
            </TooltipTrigger>
            <TooltipContent>{t("rosterPanel.removeSampleTooltip")}</TooltipContent>
          </Tooltip>
        </div>
      ))}
    </div>
  );
}

function CharCard({ c, others, selecting, selected, onSearch, onShots, onEdit, onRename, onDelete, onMergeInto, onToggle }: {
  c: Character; others: Character[]; selecting: boolean; selected: boolean;
  onSearch: () => void; onShots: () => void; onEdit: () => void; onRename: (name: string) => void;
  onDelete: () => void; onMergeInto: (sourceId: number) => void; onToggle: () => void;
}) {
  const { t } = useTranslation(["search", "common"]);
  const [renaming, setRenaming] = useState(false);
  const [showSamples, setShowSamples] = useState(false);
  // Clic n'importe où sur la carte = chercher (le geste attendu). Les contrôles internes stoppent
  // la propagation. Sans échantillon, le clic ne fait rien (tooltip explique).
  const clickable = !selecting && !renaming && c.total > 0;
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          role="button" tabIndex={selecting || clickable ? 0 : undefined}
          onClick={selecting ? onToggle : clickable ? onSearch : undefined}
          onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && (selecting || clickable)) { e.preventDefault(); (selecting ? onToggle : onSearch)(); } }}
          className={cn(
            "flex gap-3 rounded-lg border bg-card p-3 transition-colors",
            (selecting || clickable) && "cursor-pointer",
            clickable && "hover:border-primary/60 hover:bg-accent/40",
            selectionRing(selected),
          )}>
          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-muted">
            {c.avatar
              ? <img src={c.avatar} alt="" className="h-full w-full object-cover" />
              : <div className="flex h-full items-center justify-center text-muted-foreground"><ScanFace className="h-6 w-6 opacity-40" /></div>}
            {c.color && <span className="absolute bottom-1 right-1 h-3 w-3 rounded-full border border-white/60" style={{ background: c.color }} />}
            {selecting && (
              <SelectToggle selected={selected} onToggle={onToggle} className="left-1 top-1 right-auto opacity-100" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {renaming ? (
                <span onClick={(e) => e.stopPropagation()}>
                  <InlineRename
                    value={c.name}
                    onCommit={(name) => { setRenaming(false); onRename(name); }}
                    onCancel={() => setRenaming(false)}
                    className="w-40 rounded border border-border bg-transparent px-1 text-sm font-medium outline-none focus-visible:border-primary"
                  />
                </span>
              ) : (
                <Tooltip>
                  <TooltipTrigger render={<div className="truncate text-sm font-medium" />}>
                    {c.name}
                  </TooltipTrigger>
                  <TooltipContent>{c.total > 0 ? t("rosterPanel.clickToSearch") : t("rosterPanel.addFaceFirstTag")}</TooltipContent>
                </Tooltip>
              )}
              {c.samples.anime > 0 && <Badge variant="secondary" className="h-4 px-1 text-[10px]">{t("rosterPanel.animatedCount", { count: c.samples.anime })}</Badge>}
              {c.samples.real > 0 && <Badge variant="secondary" className="h-4 px-1 text-[10px]">{t("rosterPanel.realCount", { count: c.samples.real })}</Badge>}
            </div>
            {c.tags.length > 0 && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{c.tags.join(" · ")}</div>}
            {c.notes && <div className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{c.notes}</div>}
            {!selecting && (
              <div className="mt-1.5 flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger render={<Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5" disabled={c.total === 0} onClick={(e) => { e.stopPropagation(); onSearch(); }} />}>
                    <Search className="h-3.5 w-3.5" /> {t("rosterPanel.search")}
                  </TooltipTrigger>
                  <TooltipContent>{c.total === 0 ? t("rosterPanel.addFaceFirst") : t("rosterPanel.searchIndexed")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" size="icon-sm"
                    className={cn("h-7 w-7", showSamples && "bg-accent text-accent-foreground")}
                    onClick={(e) => { e.stopPropagation(); setShowSamples((v) => !v); }} />}>
                    <Images className="h-3.5 w-3.5" />
                  </TooltipTrigger>
                  <TooltipContent>{t("rosterPanel.savedFacesCount", { count: c.total })}</TooltipContent>
                </Tooltip>
                <div className="flex-1" />
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); setRenaming(true); }} />}>
                    <Pencil className="h-3.5 w-3.5" />
                  </TooltipTrigger>
                  <TooltipContent>{t("rosterPanel.rename")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={(e) => { e.stopPropagation(); onDelete(); }} />}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </TooltipTrigger>
                  <TooltipContent>{t("common:action.delete")}</TooltipContent>
                </Tooltip>
              </div>
            )}
            {!selecting && showSamples && (
              <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                <SamplesStrip charId={c.id} />
              </div>
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={c.total === 0} onClick={onSearch}><Search /> {t("rosterPanel.searchInRushes")}</ContextMenuItem>
        <ContextMenuItem onClick={onShots}><Film /> {t("rosterPanel.recognizedShots")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => setShowSamples((v) => !v)}><Images /> {t("rosterPanel.savedFaces")}</ContextMenuItem>
        <ContextMenuItem onClick={() => setRenaming(true)}><Pencil /> {t("rosterPanel.rename")}</ContextMenuItem>
        <ContextMenuItem onClick={onEdit}><Pencil /> {t("rosterPanel.edit")}</ContextMenuItem>
        <ContextMenuItem onClick={onToggle}><CheckSquare /> {selected ? t("rosterPanel.deselect") : t("rosterPanel.select")}</ContextMenuItem>
        {others.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger><Merge /> {t("rosterPanel.mergeDuplicateHere")}</ContextMenuSubTrigger>
            <ContextMenuSubContent className="max-h-64 overflow-y-auto">
              {others.map((o) => (
                <ContextMenuItem key={o.id} onClick={() => onMergeInto(o.id)} className="gap-2">
                  <span className="h-5 w-5 shrink-0 overflow-hidden rounded bg-muted">
                    {o.avatar ? <img src={o.avatar} alt="" className="h-full w-full object-cover" /> : <ScanFace className="m-0.5 h-4 w-4 text-muted-foreground" />}
                  </span>
                  <span className="truncate">{o.name}</span>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete}><Trash2 /> {t("common:action.delete")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Onglet « Personnages » du hub : barre d'actions + liste du roster (créer/éditer/fusionner/chercher).
export function RosterPanel() {
  const { t } = useTranslation(["search", "common"]);
  const {
    characters, charLabeling, duplicates, dupLoading,
    createCharacter, updateCharacter, deleteCharacter, searchByCharacter, filterByCharacter, labelIndex,
    mergeCharacters, mergeMany, findDuplicates, clearDuplicates,
  } = useApp(useShallow((s) => ({
    characters: s.characters, charLabeling: s.charLabeling, duplicates: s.duplicates, dupLoading: s.dupLoading,
    createCharacter: s.createCharacter, updateCharacter: s.updateCharacter, deleteCharacter: s.deleteCharacter,
    searchByCharacter: s.searchByCharacter, filterByCharacter: s.filterByCharacter, labelIndex: s.labelIndex,
    mergeCharacters: s.mergeCharacters, mergeMany: s.mergeMany, findDuplicates: s.findDuplicates, clearDuplicates: s.clearDuplicates,
  })));

  const [editId, setEditId] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());

  function startNew() { setEditId("new"); setDraft(EMPTY); }
  function startEdit(c: Character) { setEditId(c.id); setDraft(toDraft(c)); }
  function toggleSel(id: number) { setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function clearSel() { setSel(new Set()); setSelecting(false); }
  async function mergeSelected() {
    const ids = characters.filter((c) => sel.has(c.id)).map((c) => c.id);   // ordre d'affichage → 1er = cible
    await mergeMany(ids);
    clearSel();
  }
  async function save() {
    setSaving(true);
    const payload = { name: draft.name.trim(), notes: draft.notes, tags: parseTags(draft.tags), color: draft.color };
    try {
      if (editId === "new") await createCharacter(payload);
      else if (typeof editId === "number") await updateCharacter({ id: editId, ...payload });
    } finally { setSaving(false); setEditId(null); }
  }

  const target = characters.find((c) => sel.has(c.id));   // cible de fusion = 1er sélectionné dans l'ordre

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Barre unique : morphe en mode sélection (fusion inline, rien ne descend). */}
      <div className="flex h-8 items-center gap-1.5">
        {selecting ? (
          <>
            <span className="text-sm font-medium tabular-nums">{sel.size}</span>
            {target && sel.size >= 2 && <span className="truncate text-xs text-muted-foreground">→ « {target.name} »</span>}
            <div className="flex-1" />
            <Button size="sm" disabled={sel.size < 2} onClick={mergeSelected}>
              <Merge className="h-3.5 w-3.5" /> {t("rosterPanel.merge")}
            </Button>
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("rosterPanel.cancelSelectionAria")} onClick={clearSel} />}>
                <X className="h-4 w-4" />
              </TooltipTrigger>
              <TooltipContent>{t("common:action.cancel")}</TooltipContent>
            </Tooltip>
          </>
        ) : (
          <>
            <div className="flex-1" />
            {characters.length >= 2 && (
              <Tooltip>
                <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("rosterPanel.mergeDuplicatesAria")} onClick={() => setSelecting(true)} />}>
                  <CheckSquare className="h-4 w-4" />
                </TooltipTrigger>
                <TooltipContent>{t("rosterPanel.mergeDuplicatesTooltip")}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("rosterPanel.detectDuplicatesAria")} disabled={dupLoading || characters.length < 2} onClick={() => findDuplicates()} />}>
                {dupLoading ? <Spinner className="h-4 w-4" /> : <Spline className="h-4 w-4" />}
              </TooltipTrigger>
              <TooltipContent>{t("rosterPanel.detectDuplicatesTooltip")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("rosterPanel.recognizeAria")} disabled={!!charLabeling || characters.length === 0} onClick={() => labelIndex()} />}>
                <ScanFace className={cn("h-4 w-4", charLabeling && "animate-pulse")} />
              </TooltipTrigger>
              <TooltipContent>{t("rosterPanel.recognizeTooltip")}</TooltipContent>
            </Tooltip>
            <Button size="sm" onClick={startNew}><UserPlus className="h-3.5 w-3.5" /> {t("rosterPanel.new")}</Button>
          </>
        )}
      </div>

      <FaceModelsBanner />

      {duplicates && (
        <div className="space-y-1.5 rounded-lg border border-border bg-muted/40 p-3">
          <div className="flex items-center gap-2 text-xs">
            <Spline className="h-3.5 w-3.5 text-primary" />
            <span className="font-medium">{t("rosterPanel.possibleDuplicates")}</span>
            <div className="flex-1" />
            <Button variant="ghost" size="icon-xs" aria-label={t("rosterPanel.closeAria")} onClick={clearDuplicates}><X className="h-3 w-3" /></Button>
          </div>
          {duplicates.length === 0 ? (
            <div className="text-[11px] text-muted-foreground">{t("rosterPanel.noDuplicates")}</div>
          ) : duplicates.map((p) => (
            <div key={`${p.a.id}-${p.b.id}`} className="flex items-center gap-2 text-xs">
              <span className="truncate"><b>{p.a.name}</b> · <b>{p.b.name}</b></span>
              <Badge variant="secondary" className="h-4 px-1 text-[10px]">{Math.round(p.score * 100)}%</Badge>
              <div className="flex-1" />
              <Tooltip>
                <TooltipTrigger render={<Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={() => mergeCharacters(p.b.id, p.a.id)} />}>
                  <Merge className="h-3 w-3" /> {t("rosterPanel.merge")}
                </TooltipTrigger>
                <TooltipContent>{t("rosterPanel.mergeIntoTooltip", { source: p.b.name, target: p.a.name })}</TooltipContent>
              </Tooltip>
            </div>
          ))}
        </div>
      )}

      {charLabeling && (
        <div className="space-y-1">
          <Progress value={charLabeling.pct} />
          <div className="text-[11px] text-muted-foreground">{t("rosterPanel.recognizing", { pct: Math.round(charLabeling.pct) })}</div>
        </div>
      )}

      {editId === "new" && <CharForm draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setEditId(null)} saving={saving} />}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {characters.length === 0 && editId !== "new" ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
            <Users className="h-7 w-7 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">{t("rosterPanel.noCharacters")}</span>
          </div>
        ) : (
          characters.map((c) => (
            editId === c.id
              ? <CharForm key={c.id} draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setEditId(null)} saving={saving} />
              : <CharCard key={c.id} c={c} others={characters.filter((o) => o.id !== c.id)}
                  selecting={selecting} selected={sel.has(c.id)}
                  onSearch={() => searchByCharacter(c.id, c.name)}
                  onShots={() => filterByCharacter(c.id, c.name)}
                  onEdit={() => startEdit(c)}
                  onRename={(name) => void updateCharacter({ id: c.id, name })}
                  onDelete={() => deleteCharacter(c.id)}
                  onMergeInto={(sourceId) => mergeCharacters(sourceId, c.id)}
                  onToggle={() => { setSelecting(true); toggleSel(c.id); }} />
          ))
        )}
      </div>
    </div>
  );
}
