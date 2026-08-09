// Sous-menu « Ranger dans une collection » pour les clics droits (recherche, etc.).
// Réutilise le store collections (loadCollections/rangeShots) — chargement paresseux à l'ouverture.
import { useState } from "react";
import { FolderPlus, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import type { CollectionShot } from "@/lib/bridge";
import {
  ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent, ContextMenuItem,
} from "@/components/ui/context-menu";
import { Spinner } from "@/components/ui/spinner";
import { CollectionGlyph } from "./collectionGlyph";

export function CollectionSubmenu({ shots }: { shots: CollectionShot[] }) {
  const { t } = useTranslation("collections");
  const { collections, loadCollections, rangeShots } = useApp(useShallow((s) => ({
    collections: s.collections, loadCollections: s.loadCollections, rangeShots: s.rangeShots,
  })));
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function range(id: string) {
    setBusy(id);
    const r = await rangeShots(id, shots);
    setBusy(null);
    if (r.ok) setDone(id);   // coche éphémère (le menu se ferme peu après)
  }

  return (
    <ContextMenuSub onOpenChange={(o) => { if (o) void loadCollections(); }}>
      <ContextMenuSubTrigger><FolderPlus /> {t("submenu.rangeIn")}</ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-h-64 overflow-y-auto">
        {collections.length === 0 ? (
          <ContextMenuItem disabled>{t("submenu.none")}</ContextMenuItem>
        ) : (
          collections.map((c) => (
            <ContextMenuItem key={c.id} closeOnClick={false} disabled={!!busy}
              onClick={() => void range(c.id)} className="gap-2">
              <CollectionGlyph icon={c.icon} color={c.color} size={20} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {busy === c.id ? <Spinner className="size-3.5" />
                : done === c.id ? <Check className="size-3.5 text-[var(--color-ok)]" strokeWidth={3} />
                : <span className="text-[11px] tabular-nums text-muted-foreground">{c.count}</span>}
            </ContextMenuItem>
          ))
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
