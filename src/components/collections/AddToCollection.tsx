// Bouton « Ranger » : range un (ou plusieurs) plan(s) dans une collection, vite, SANS quitter la page
// (derush / timeline live / recherche). Popover Base UI : RECHERCHE + section FAVORIS (épinglés, accès
// en un clic) + toutes les collections + création inline. Favoris persistés (localStorage). Partagé partout.
import { useEffect, useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { FolderPlus, Check, Plus, Search, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { Spinner } from "@/components/ui/spinner";
import { type CollectionShot, type CollectionMeta } from "@/lib/bridge";
import { CollectionGlyph, DEFAULT_COLLECTION_COLOR } from "./collectionGlyph";
import { loadCollFavs, saveCollFavs } from "./collectionShared";
import { cn } from "@/lib/utils";

export function AddToCollection({
  shots, className, stopPropagation = true,
}: {
  shots: CollectionShot[];          // plan(s) à ranger (id généré côté core)
  className?: string;               // style du déclencheur (bouton-icône)
  stopPropagation?: boolean;        // évite de déclencher le clic de la carte sous le bouton
}) {
  const { t } = useTranslation(["collections", "common"]);
  const { collections, loadCollections, rangeShots, createCollection } = useApp(
    useShallow((s) => ({
      collections: s.collections, loadCollections: s.loadCollections,
      rangeShots: s.rangeShots, createCollection: s.createCollection,
    })),
  );

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);   // id en cours de rangement
  const [done, setDone] = useState<string | null>(null);   // id rangé (coche éphémère)
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [q, setQ] = useState("");
  const [favs, setFavs] = useState<string[]>(loadCollFavs);

  useEffect(() => { if (open) { void loadCollections(); setFavs(loadCollFavs()); } }, [open, loadCollections]);

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
    const r = await rangeShots(id, shots);
    setBusy(null);
    if (r.ok) { setDone(id); setTimeout(() => { setDone(null); setOpen(false); }, 700); }
  }
  async function createAndRange() {
    const n = name.trim();
    if (!n) return;
    setBusy("__new__");
    const id = await createCollection({ name: n, color: DEFAULT_COLLECTION_COLOR });
    if (id) await rangeShots(id, shots);
    setBusy(null);
    setName(""); setCreating(false); setOpen(false);
  }

  const Row = (c: CollectionMeta) => (
    <div key={c.id} className="group/row flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-accent">
      <button type="button" onClick={() => range(c.id)} disabled={!!busy}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm disabled:opacity-60">
        <CollectionGlyph icon={c.icon} color={c.color} size={22} />
        <span className="min-w-0 flex-1 truncate">{c.name}</span>
        {busy === c.id ? <Spinner className="size-3.5 text-muted-foreground" />
          : done === c.id ? <Check className="h-3.5 w-3.5 text-[var(--color-ok)]" strokeWidth={3} />
          : <span className="text-[11px] tabular-nums text-muted-foreground">{c.count}</span>}
      </button>
      <button type="button" aria-label={favs.includes(c.id) ? t("fav.remove") : t("fav.pin")}
        onClick={(e) => { e.stopPropagation(); toggleFav(c.id); }}
        className={cn("shrink-0 rounded p-1 transition-opacity", favs.includes(c.id) ? "text-amber-400" : "text-muted-foreground opacity-0 hover:text-foreground group-hover/row:opacity-100")}>
        <Star className={cn("h-3.5 w-3.5", favs.includes(c.id) && "fill-current")} />
      </button>
    </div>
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={t("range.trigger")}
        onClick={(e) => { if (stopPropagation) e.stopPropagation(); }}
        className={cn("inline-flex items-center justify-center rounded transition-colors", className)}
      >
        <FolderPlus className="h-3.5 w-3.5" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={6} className="z-50 outline-none">
          <Popover.Popup
            onClick={(e) => e.stopPropagation()}
            className="w-64 origin-[var(--transform-origin)] rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl outline-none data-[starting-style]:scale-98 data-[starting-style]:opacity-0 transition-[transform,opacity]"
          >
            <div className="px-1 pb-1.5 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("range.rangeTitle", { count: shots.length })}
            </div>
            {/* Recherche rapide */}
            <div className="mb-1 flex items-center gap-1.5 rounded-md border border-border bg-background px-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input aria-label={t("search.short")} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search.short")} className="w-full bg-transparent py-1.5 text-sm outline-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            </div>

            <div className="max-h-64 overflow-y-auto">
              {favList.length > 0 && (
                <>
                  <div className="flex items-center gap-1 px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-amber-400/80"><Star className="size-2.5 fill-current" /> {t("fav.favorites")}</div>
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
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") void createAndRange(); if (e.key === "Escape") setCreating(false); }}
                  placeholder={t("folder.namePlaceholder")} className="h-7 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary" />
                <button type="button" onClick={createAndRange} disabled={!name.trim() || !!busy}
                  className="inline-flex h-7 shrink-0 items-center rounded-md bg-primary px-2 text-xs text-primary-foreground disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {busy === "__new__" ? <Spinner className="size-3.5" /> : t("common:status.ok")}
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setCreating(true)}
                className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-border px-2 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground">
                <Plus className="h-4 w-4" /> {t("folder.new")}
              </button>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
