// Bouton « Ranger » : range un (ou plusieurs) plan(s) dans une collection, vite, SANS quitter la page
// (derush / timeline live / recherche). Popover Base UI : RECHERCHE + section FAVORIS (épinglés, accès
// en un clic) + toutes les collections + création inline. Favoris persistés (localStorage). Partagé partout.
import { useEffect, useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type CollectionShot, type CollectionMeta } from "@/lib/bridge";
import { CollectionGlyph, DEFAULT_COLLECTION_COLOR } from "./collectionGlyph";
import { loadCollFavs, saveCollFavs } from "./collectionShared";
import { useRangeSelection } from "./rangeSelection";
import { cn } from "@/lib/utils";

// Ce bouton est posé sur CHAQUE carte de plan : une grille de derush en monte plusieurs centaines.
// Le déclencheur ne fait donc rien d'autre que porter l'état ouvert/fermé — aucun abonnement au
// store, aucune lecture de localStorage, aucun filtrage de collections tant qu'il est fermé. Tout ça
// vivait ici et re-tournait à chaque rendu de carte (le défilement en provoque beaucoup), et la
// moindre écriture dans le store des collections re-rendait toutes les cartes de la grille.
export function AddToCollection({
  shots, className, stopPropagation = true, onOpenChange,
}: {
  shots: CollectionShot[];          // plan(s) à ranger (id généré côté core)
  className?: string;               // style du déclencheur (bouton-icône)
  stopPropagation?: boolean;        // évite de déclencher le clic de la carte sous le bouton
  // The popover overflows its card: a card that mounts this button on hover must keep it while open.
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation("collections");
  const [open, setOpen] = useState(false);
  const change = (o: boolean) => { setOpen(o); onOpenChange?.(o); };
  return (
    <Popover.Root open={open} onOpenChange={change}>
      <Popover.Trigger
        aria-label={t("range.trigger")}
        onClick={(e) => { if (stopPropagation) e.stopPropagation(); }}
        className={cn("inline-flex items-center justify-center rounded transition-colors", className)}
      >
        <NetsuIcon name="folder-plus" className="size-3.5" />
      </Popover.Trigger>
      {open && <CollectionPicker shots={shots} close={() => change(false)} />}
    </Popover.Root>
  );
}

// Mini icon switch of the title row ("this shot" / "the selection").
const SCOPE_ITEM = "h-5 min-w-5 gap-0.5 rounded px-1 text-muted-foreground aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:hover:bg-primary/15";

// Contenu du popover : monté seulement à l'ouverture.
function CollectionPicker({ shots, close }: { shots: CollectionShot[]; close: () => void }) {
  const { t } = useTranslation(["collections", "common"]);
  const { collections, loadCollections, rangeShots, createCollection } = useApp(
    useShallow((s) => ({
      collections: s.collections, loadCollections: s.loadCollections,
      rangeShots: s.rangeShots, createCollection: s.createCollection,
    })),
  );

  const [busy, setBusy] = useState<string | null>(null);   // id en cours de rangement
  const [done, setDone] = useState<string | null>(null);   // id rangé (coche éphémère)
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [q, setQ] = useState("");
  const [favs, setFavs] = useState<string[]>(loadCollFavs);
  // A selection is often built for something else (timeline, export): ranging it is a choice made
  // here, never implied. Offered (and preselected) only from a card that belongs to it.
  const { selection, offer } = useRangeSelection(shots);
  const [scope, setScope] = useState<"one" | "selection">("selection");
  const targets = offer && scope === "selection" ? selection : shots;

  useEffect(() => { void loadCollections(); setFavs(loadCollFavs()); }, [loadCollections]);

  const toggleFav = (id: string) => setFavs((f) => { const n = f.includes(id) ? f.filter((x) => x !== id) : [...f, id]; saveCollFavs(n); return n; });

  const { favList, others } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = collections.filter((c) => !needle || c.name.toLowerCase().includes(needle));
    const favSet = new Set(favs);
    return {
      favList: filtered.filter((c) => favSet.has(c.id)),
      others: filtered.filter((c) => !favSet.has(c.id)),
    };
  }, [collections, q, favs]);

  async function range(id: string) {
    setBusy(id);
    const r = await rangeShots(id, targets);
    setBusy(null);
    if (r.ok) { setDone(id); setTimeout(() => { setDone(null); close(); }, 700); }
  }
  async function createAndRange() {
    const n = name.trim();
    if (!n) return;
    setBusy("__new__");
    const id = await createCollection({ name: n, color: DEFAULT_COLLECTION_COLOR });
    if (id) await rangeShots(id, targets);
    setBusy(null);
    setName(""); setCreating(false); close();
  }

  // Collection partagée EN LECTURE : on n'y range rien. Laisser essayer écrivait le plan dans la copie
  // locale, la publication était refusée par le serveur, et il restait là — invisible et jamais partagé.
  const readOnly = (c: CollectionMeta) => !!c.collaboration?.projectId && c.collaboration.role === "viewer";

  const Row = (c: CollectionMeta) => (
    <div key={c.id} className="group/row flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-accent">
      <Button variant="ghost" onClick={() => range(c.id)} disabled={!!busy || readOnly(c)}
        className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-normal hover:bg-transparent dark:hover:bg-transparent">
        <CollectionGlyph icon={c.icon} color={c.color} size={22} />
        <span className="min-w-0 flex-1 truncate">{c.name}</span>
        {busy === c.id ? <Spinner className="size-3.5 text-muted-foreground" />
          : done === c.id ? <NetsuIcon name="check" className="size-3.5 text-[var(--color-ok)]" />
          : !readOnly(c) && <span className="text-[11px] tabular-nums text-muted-foreground">{c.count}</span>}
      </Button>
      {/* Le cadenas vit HORS du bouton désactivé : un élément désactivé n'émet aucun survol, sa bulle
          ne s'ouvrirait jamais. */}
      {readOnly(c) && <Tooltip>
        <TooltipTrigger render={<span className="shrink-0 text-muted-foreground" />}><NetsuIcon name="lock" on className="size-3" /></TooltipTrigger>
        <TooltipContent>{t("share.readOnly")}</TooltipContent>
      </Tooltip>}
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={favs.includes(c.id) ? t("fav.remove") : t("fav.pin")}
          onClick={(e) => { e.stopPropagation(); toggleFav(c.id); }}
          className={cn("shrink-0 transition-opacity focus-visible:opacity-100", favs.includes(c.id) ? "text-amber-400" : "text-muted-foreground opacity-0 hover:text-foreground group-hover/row:opacity-100")} />}>
          <NetsuIcon name="cut-favorite" on={favs.includes(c.id)} className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>{favs.includes(c.id) ? t("fav.remove") : t("fav.pin")}</TooltipContent>
      </Tooltip>
    </div>
  );

  return (
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={6} className="z-50 outline-none">
          <Popover.Popup
            aria-label={t("range.rangeTitle", { count: targets.length })}
            onClick={(e) => e.stopPropagation()}
            // Les touches du popover ne redescendent JAMAIS à la carte porteuse : par un portail,
            // React les fait remonter dans son arbre, où une grille de plans écoute Espace/Entrée.
            onKeyDown={(e) => e.stopPropagation()}
            className="max-h-(--available-height) overflow-x-hidden overflow-y-auto scrollbar-inset w-64 origin-[var(--transform-origin)] rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl outline-none data-[starting-style]:scale-98 data-[starting-style]:opacity-0 transition-[transform,opacity]"
          >
            {/* Search field and scope switch share ONE compact row: no title line, no extra row in a
                popover already short on room. The switch shows up only when a selection exists. */}
            <div className="mb-1 flex h-7 items-center gap-1.5 rounded-md border border-border bg-background pl-2 pr-0.5 has-[input:focus-visible]:ring-1 has-[input:focus-visible]:ring-ring">
              <NetsuIcon name="search" className="size-3.5 shrink-0 text-muted-foreground" />
              <Input autoComplete="off" spellCheck={false} aria-label={t("search.short")} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search.short")} className="h-full min-w-0 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0 dark:bg-transparent" />
              {offer && (
                <ToggleGroup aria-label={t("range.scope")} value={[scope]} spacing={0} className="shrink-0 border-l border-border pl-0.5"
                  onValueChange={(v) => { const n = v[0]; if (n === "one" || n === "selection") setScope(n); }}>
                  <Tooltip>
                    <TooltipTrigger render={<ToggleGroupItem value="one" aria-label={t("range.scopeOne")} className={SCOPE_ITEM} />}>
                      <NetsuIcon name="checkbox-off" className="size-3" />
                    </TooltipTrigger>
                    <TooltipContent>{t("range.scopeOne")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger render={<ToggleGroupItem value="selection" aria-label={t("range.scopeSelection", { count: selection.length })} className={SCOPE_ITEM} />}>
                      <NetsuIcon name="stack" className="size-3" />
                      <span className="text-[10px] tabular-nums">{selection.length}</span>
                    </TooltipTrigger>
                    <TooltipContent>{t("range.scopeSelection", { count: selection.length })}</TooltipContent>
                  </Tooltip>
                </ToggleGroup>
              )}
            </div>

            <div className="max-h-64 overflow-y-auto">
              {favList.length > 0 && (
                <>
                  <div className="flex items-center gap-1 px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-amber-400/80"><NetsuIcon name="star" on className="size-2.5" /> {t("fav.favorites")}</div>
                  {favList.map(Row)}
                  {others.length > 0 && <div className="my-1 h-px bg-border" />}
                </>
              )}
              {others.map(Row)}
              {!favList.length && !others.length && (
                <p className="px-2 py-2 text-xs text-muted-foreground">{collections.length ? t("search.noResult") : t("empty.noneCreate")}</p>
              )}
            </div>

            {creating ? (
              <div className="mt-1 flex items-center gap-1.5 border-t border-border px-1.5 pt-2">
                <Input autoComplete="off" autoFocus value={name} onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") void createAndRange(); if (e.key === "Escape") setCreating(false); }}
                  placeholder={t("folder.namePlaceholder")} className="h-7 min-w-0 text-xs" />
                <Button size="sm" onClick={createAndRange} disabled={!name.trim() || !!busy} className="h-7 shrink-0 px-2 text-xs">
                  {busy === "__new__" ? <Spinner className="size-3.5" /> : t("common:status.ok")}
                </Button>
              </div>
            ) : (
              <Button variant="ghost" onClick={() => setCreating(true)}
                className="mt-1 h-auto w-full justify-start gap-2 rounded-lg border-t border-border px-2 py-2 text-left text-sm font-normal text-muted-foreground hover:text-foreground">
                <NetsuIcon name="add" className="size-4" /> {t("folder.new")}
              </Button>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
  );
}
