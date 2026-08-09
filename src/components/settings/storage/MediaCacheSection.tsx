// Section « Cache médias » : poids total, répartition par type, arbre par projet, purge.
// Toute suppression passe par un Dialog de confirmation (patron CleanupSection.tsx:191).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { AlertTriangle, Clock3, Database, Gauge, RefreshCw, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApp } from "@/store";
import { CacheTree } from "./CacheTree";
import { CacheDirRow } from "./CacheDirRow";
import { CACHE_KIND_LIST, fmtBytes, KIND_ICON, KIND_TINT, isDbKind, isDurableKind, isExpensive, isSessionKind, type CacheKind } from "./storageShared";
import type { CacheKindStat } from "@/lib/bridge";

type Target = { kinds?: CacheKind[]; sources?: string[]; unattributed?: boolean; size: number };

/** Seuils dépassés (cache trop gros, disque presque plein) : l'alerte s'affiche là où on la traite. */
function WarnBanner() {
  const { t } = useTranslation("settings");
  const warn = useApp((s) => s.cacheWarn);
  if (!warn || !warn.alerts.length) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-foreground" />
      <div className="min-w-0 flex-1 space-y-0.5">
        {warn.alerts.map((alert, i) => (
          <p key={i} className="text-xs text-foreground">
            {alert.kind === "disk"
              ? t("storage.warn.disk", { size: fmtBytes(alert.bytes) })
              : t("storage.warn.cache", { size: fmtBytes(alert.bytes) })}
          </p>
        ))}
      </div>
    </div>
  );
}

function KindRow({ kind, bytes, onPurge }: { kind: CacheKind; bytes: number; onPurge: () => void }) {
  const { t } = useTranslation("settings");
  const Icon = KIND_ICON[kind];
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5">
      <Icon className="size-4 shrink-0" style={{ color: KIND_TINT[kind] }} />
      <div className="min-w-0 flex-1">
        <Tooltip>
          <TooltipTrigger render={<p className="truncate text-xs text-foreground" />}>{t(`storage.kind.${kind}`)}</TooltipTrigger>
          <TooltipContent className="max-w-64">{t(`storage.kindHint.${kind}`)}</TooltipContent>
        </Tooltip>
        <p className="text-[11px] tabular-nums text-muted-foreground">{fmtBytes(bytes)}</p>
      </div>
      {bytes > 0 && (
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={onPurge} />}>
            <Trash2 className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>{t("storage.confirm.title")}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function CacheGroup({ id, kinds, always = false, onPurge }: {
  id: "session" | "reusable" | "durable";
  kinds: Array<CacheKindStat & { shownBytes: number }>;
  always?: boolean;
  onPurge: (kind: CacheKind, bytes: number) => void;
}) {
  const { t } = useTranslation("settings");
  if (!always && kinds.length === 0) return null;
  const total = kinds.reduce((sum, kind) => sum + kind.shownBytes, 0);
  const GroupIcon = id === "session" ? Clock3 : id === "reusable" ? Gauge : Database;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-start gap-2.5 border-b border-border bg-muted/25 px-3 py-2.5">
        <GroupIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-medium text-foreground">{t(`storage.lifecycle.${id}`)}</h3>
            {id === "session" && <Badge variant="secondary">{t("storage.lifecycle.sessionBadge")}</Badge>}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t(`storage.lifecycle.${id}Desc`)}</p>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-foreground">{fmtBytes(total)}</span>
      </div>
      <div className="divide-y divide-border">
        {kinds.map((kind) => (
          <KindRow
            key={kind.kind}
            kind={kind.kind}
            bytes={kind.shownBytes}
            onPurge={() => onPurge(kind.kind, kind.shownBytes)}
          />
        ))}
        {kinds.length === 0 && (
          <p className="px-3 py-2.5 text-[11px] text-muted-foreground">{t("storage.lifecycle.sessionEmpty")}</p>
        )}
      </div>
    </div>
  );
}

export function MediaCacheSection() {
  const { t } = useTranslation(["settings", "common"]);
  const s = useApp(
    useShallow((st) => ({
      overview: st.cacheOverview,
      tree: st.cacheTree,
      loading: st.cacheLoading,
      busy: st.cacheBusy,
      progress: st.cacheProgress,
      load: st.loadCache,
      clear: st.clearCache,
      reindex: st.reindexCache,
    })),
  );
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<Target | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { void s.load(); }, [s.load]);

  const toggle = (sources: string[], on: boolean) =>
    setSel((prev) => {
      const next = new Set(prev);
      for (const src of sources) on ? next.add(src) : next.delete(src);
      return next;
    });

  const selBytes = (() => {
    if (!s.tree) return 0;
    let n = 0;
    for (const f of s.tree.folders) for (const r of f.rushes) if (sel.has(r.source)) n += r.bytes;
    return n;
  })();

  async function confirm() {
    if (!target) return;
    const { size: _size, ...opts } = target;
    void _size;
    const r = await s.clear(opts);
    setTarget(null);
    setSel(new Set());
    if (!r.ok) return setNotice(r.error || t("common:action.error"));
    const base = r.rows
      ? t("settings:storage.confirm.doneRows", { size: fmtBytes(r.freed), files: r.files ?? 0, rows: r.rows })
      : t("settings:storage.confirm.done", { size: fmtBytes(r.freed), files: r.files ?? 0 });
    setNotice(base + (r.skipped ? t("settings:storage.confirm.skipped", { count: r.skipped }) : ""));
  }

  if (s.loading && !s.overview) {
    return (
      <section className="space-y-3">
        <Skeleton className="h-4 w-40" />
        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
        </div>
      </section>
    );
  }
  if (!s.overview) return null;

  const ov = s.overview;
  const reindexing = s.busy === "reindex";
  const purging = s.busy === "purge";
  // Le total de l'index sous-estime tant que « Réindexer » n'a pas tourné : on affiche le poids RÉEL
  // du disque, sinon un cache de plusieurs Go s'annoncerait à 0.
  const shown = Math.max(ov.total, ov.totalOnDisk);
  // Du cache existe, mais l'index ne le connaît pas encore → l'arbre par projet serait vide et
  // trompeur. On propose la réindexation plutôt que de laisser croire qu'il n'y a rien à ranger.
  // Heuristique portant sur l'index des FICHIERS : les types stockés en base y sont étrangers (leur
  // poids est lu par requête, jamais indexé). Les compter suffisait à faire croire l'index à jour.
  const fileReusable = ov.kinds.filter((kind) => kind.lifecycle === "reusable" && !isDbKind(kind.kind));
  const reusableOnDisk = fileReusable.reduce((sum, kind) => sum + (kind.onDisk ?? 0), 0);
  const reusableIndexed = fileReusable.reduce((sum, kind) => sum + kind.bytes, 0);
  const needsReindex = reusableOnDisk > 0 && reusableIndexed === 0;
  // Compat HMR : si le renderer neuf parle quelques secondes à l'ancien core, déduire la famille
  // localement évite une page vide jusqu'au redémarrage Tauri requis par les changements backend.
  const withShown = ov.kinds
    .map((kind) => ({
      ...kind,
      lifecycle: kind.lifecycle || (isSessionKind(kind.kind) ? "session" : isDurableKind(kind.kind) ? "durable" : "reusable"),
      shownBytes: Math.max(kind.bytes, kind.onDisk ?? 0),
    }))
    // Le core énumère ses racines de fichiers puis ses tables : l'ordre d'affichage est celui de
    // CACHE_KIND_LIST, qui range les types par famille (les deux caches de vignettes se suivent).
    .sort((a, b) => CACHE_KIND_LIST.indexOf(a.kind) - CACHE_KIND_LIST.indexOf(b.kind));
  // Les trois familles répondent à la vraie question utilisateur : « quand est-ce que ça part ? ».
  // Les types à 0 restent visibles uniquement pour la session, afin que la garantie de nettoyage
  // soit compréhensible avant même le premier traitement.
  const sessionKinds = withShown.filter((kind) => kind.lifecycle === "session");
  const reusableKinds = withShown.filter((kind) => kind.lifecycle === "reusable" && kind.shownBytes > 0);
  const durableKinds = withShown.filter((kind) => kind.lifecycle === "durable" && kind.shownBytes > 0);
  const purgeKind = (kind: CacheKind, bytes: number) => setTarget({ kinds: [kind], size: bytes });

  return (
    <section className="space-y-4">
      <WarnBanner />
      {/* Pas de titre : l'onglet nomme déjà le panneau. Le total EST l'en-tête, les actions le
          rejoignent sur la même ligne — deux rangées gagnées sur une page qui débordait. */}
      <div className="flex items-baseline gap-3">
        <span className="text-2xl font-semibold tabular-nums text-foreground">{fmtBytes(shown)}</span>
        {ov.disk && (
          <span className="text-xs text-muted-foreground">
            {t("settings:storage.diskFree", { free: fmtBytes(ov.disk.free), total: fmtBytes(ov.disk.total) })}
          </span>
        )}
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => void s.reindex()} disabled={!!s.busy} />}>
            <Wand2 className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{t("settings:storage.reindex.hint")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => void s.load()} disabled={!!s.busy} />}>
            <RefreshCw className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>{t("settings:storage.refresh")}</TooltipContent>
        </Tooltip>
      </div>

      {reindexing && s.progress && (
        <div className="space-y-1">
          <Progress value={s.progress.pct} />
          <p className="text-[11px] text-muted-foreground">{t(`settings:storage.reindex.${s.progress.phase === "scan" ? "scan" : "index"}`)}</p>
        </div>
      )}

      {shown === 0 ? (
        <>
          <CacheGroup id="session" kinds={sessionKinds} always onPurge={purgeKind} />
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <p className="text-xs text-foreground">{t("settings:storage.empty")}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{t("settings:storage.emptyHint")}</p>
          </div>
        </>
      ) : (
        <>
          {needsReindex && !reindexing && (
            <div className="flex items-center gap-3 rounded-lg border border-dashed border-border p-3">
              <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">{t("settings:storage.reindex.hint")}</p>
              <Button variant="outline" size="sm" onClick={() => void s.reindex()} disabled={!!s.busy}>
                <Wand2 className="size-3.5" /> {t("settings:storage.reindex.action")}
              </Button>
            </div>
          )}

          <div className="space-y-2.5">
            <CacheGroup id="session" kinds={sessionKinds} always onPurge={purgeKind} />
            <CacheGroup id="reusable" kinds={reusableKinds} onPurge={purgeKind} />
            <CacheGroup id="durable" kinds={durableKinds} onPurge={purgeKind} />
          </div>

          {s.tree && (s.tree.folders.length > 0 || s.tree.unattributed.bytes > 0) && (
            <div className="space-y-2">
              <div>
                <h3 className="text-xs font-medium text-foreground">{t("settings:storage.tree.title")}</h3>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{t("settings:storage.tree.desc")}</p>
              </div>
              <CacheTree
                tree={s.tree}
                selected={sel}
                onToggle={toggle}
                onPurgeUnattributed={() => setTarget({ unattributed: true, size: s.tree!.unattributed.bytes })}
              />
              {sel.size > 0 && (
                <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <span className="text-xs text-foreground">
                    {t("settings:storage.tree.selected", { count: sel.size, size: fmtBytes(selBytes) })}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => setSel(new Set())}>{t("settings:storage.tree.clearSelection")}</Button>
                    <Button variant="destructive" size="sm" disabled={purging} onClick={() => setTarget({ sources: [...sel], size: selBytes })}>
                      <Trash2 className="size-3.5" /> {t("settings:storage.tree.purgeSelection")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <CacheDirRow overview={ov} onDone={setNotice} />

      {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings:storage.confirm.title")}</DialogTitle>
            <DialogDescription>
              {target?.sources
                ? t("settings:storage.confirm.descSources", { size: fmtBytes(target.size), count: target.sources.length })
                : target?.unattributed
                  ? t("settings:storage.confirm.descUnattributed", { size: fmtBytes(target?.size ?? 0) })
                  : t("settings:storage.confirm.descKinds", { size: fmtBytes(target?.size ?? 0) })}
            </DialogDescription>
          </DialogHeader>
          {/* Avertissement renforcé : reconstruire un index de recherche coûte des heures de GPU —
              ça ne se compare pas à un proxy régénéré en une seconde. */}
          {isExpensive(target?.kinds) && (
            <p className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-foreground">{t("settings:storage.confirm.expensive")}</p>
          )}
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setTarget(null)}>{t("settings:storage.confirm.cancel")}</Button>
            <Button variant="destructive" size="sm" onClick={() => void confirm()} disabled={purging}>
              <Trash2 className="size-3.5" /> {purging ? t("settings:storage.confirm.purging") : t("settings:storage.confirm.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
