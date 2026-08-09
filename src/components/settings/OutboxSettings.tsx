// Réglages « Cache projet » (Paramètres › Cache projet) : file d'attente des envois vers le montage
// différés quand le logiciel (Resolve/Premiere/AE) est fermé, appliqués automatiquement à la
// réouverture. Permet de fermer Resolve pour libérer le GPU pendant des encodes lourds sans perdre
// les envois. Réglages : activation, délai, cible (nouvelle timeline vs timeline collectrice unique).
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, CircleAlert, Clock, Play, Trash2, X, Film, RefreshCw, Loader2 } from "lucide-react";
import { useApp } from "@/store";
import { nr, type SnapshotState, type SnapshotProgress } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { hostShort } from "@/lib/host";
import { Trans, useTranslation } from "react-i18next";

// Cache HORS-LIGNE (lecture) : construit/rafraîchit en arrière-plan pendant que Resolve est ouvert →
// à la fermeture tout est déjà là, et on peut ouvrir n'importe quelle timeline offline. Incrémental
// (ne relit que les nouvelles timelines) ; « Tout recalculer » force le sweep complet. Ce panneau est
// LIÉ au même système : la progression affichée est le flux réel `snapshot:progress` (qu'il vienne du
// bouton, de l'auto-build App, ou de la fermeture) → il reflète TOUJOURS l'état vivant du cache.
function OfflineCacheBlock() {
  const { t } = useTranslation("settings");
  const connected = useApp((s) => !!s.status?.connected);
  const [snap, setSnap] = useState<SnapshotState | null>(null);
  const [prog, setProg] = useState<SnapshotProgress | null>(null);

  const refreshSnap = () => { nr.snapshot?.state().then(setSnap).catch(() => {}); };
  useEffect(() => { refreshSnap(); const off = nr.snapshot?.onChanged(setSnap); return () => off?.(); }, []);
  // La progression pilote l'état « en cours » : un build lancé N'IMPORTE OÙ (bouton, auto, fermeture)
  // s'affiche ici. `done` → on rafraîchit le compteur.
  useEffect(() => {
    const off = nr.snapshot?.onProgress((p) => {
      if (p.done) { setProg(null); refreshSnap(); } else setProg(p);
    });
    return () => off?.();
  }, []);

  const building = !!prog;
  const total = snap?.timelines ?? 0;
  const cached = snap?.cuts ?? 0;
  const upToDate = total > 0 && cached >= total;
  // Barre = progression VIVE si un build tourne, sinon ratio de couverture du cache (cuts/timelines).
  const barPct = building ? (prog?.pct ?? 0) : total ? Math.round((100 * cached) / total) : 0;

  const build = (force: boolean) => { if (connected && !building) void nr.snapshot?.build({ force }); };

  return (
    <div className="space-y-2.5 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Film className="size-4 text-muted-foreground" />
          <div>
            <span className="flex items-center gap-1.5 text-[0.8125rem]">
              {t("outbox.offline.title")}
              {upToDate && !building && <span className="inline-flex items-center gap-0.5 text-[10px] text-[var(--color-ok)]"><Check className="size-3" /> {t("outbox.offline.upToDate")}</span>}
            </span>
            <span className="block text-[11px] text-muted-foreground">
              {snap
                ? t("outbox.offline.stats", { clips: snap.clips, cached, total })
                : t("outbox.offline.none")}
            </span>
          </div>
        </div>
        <Button size="sm" variant="outline" disabled={!connected || building} onClick={() => build(false)}>
          {building ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {t("outbox.offline.update")}
        </Button>
      </div>

      {/* Barre TOUJOURS visible : reflète la couverture du cache, et vire en direct pendant un build. */}
      <div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className={"h-full transition-all " + (upToDate && !building ? "bg-[var(--color-ok)]" : "bg-primary")} style={{ width: `${barPct}%` }} />
        </div>
        {building && prog?.msg && <p className="mt-1 text-[11px] text-muted-foreground">{prog.msg}</p>}
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-muted-foreground">
          {!connected ? t("outbox.offline.needResolve") : building ? t("outbox.offline.building") : t("outbox.offline.auto")}
        </span>
        <Button size="sm" variant="ghost" disabled={!connected || building} onClick={() => build(true)}>{t("outbox.offline.rebuild")}</Button>
      </div>
    </div>
  );
}

export function OutboxSettings() {
  const { t } = useTranslation("settings");
  const { outbox, setSettings, remove, clear, flush } = useApp(
    useShallow((s) => ({
      outbox: s.outbox, setSettings: s.outboxSetSettings, remove: s.outboxRemove, clear: s.outboxClear, flush: s.outboxFlush,
    })),
  );
  const settings = outbox?.settings;
  const entries = outbox?.entries ?? [];
  const pending = entries.filter((e) => e.status === "pending");

  if (!settings) {
    return <section><p className="text-xs text-muted-foreground">{t("outbox.opening")}</p></section>;
  }

  return (
    <section className="space-y-5">
      {/* Pas de titre : l'onglet « Cache projet » de Paramètres › Stockage nomme déjà le panneau.
          L'explication reste : ce que fait la file n'est pas devinable depuis son nom. */}
      <p className="text-xs text-muted-foreground"><Trans t={t} i18nKey="outbox.intro" components={{ b: <b /> }} /></p>

      <OfflineCacheBlock />

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <span className="block text-[0.8125rem]">{t("outbox.enabled")}</span>
          <span className="block text-[11px] text-muted-foreground">{t("outbox.enabledHint")}</span>
        </div>
        <Toggle pressed={settings.enabled} onPressedChange={(v) => void setSettings({ enabled: v })}
          className="aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary">
          {settings.enabled ? t("outbox.on") : t("outbox.off")}
        </Toggle>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div className="flex items-center gap-2">
          <Clock className="size-4 text-muted-foreground" />
          <div>
            <span className="block text-[0.8125rem]">{t("outbox.delay")}</span>
            <span className="block text-[11px] text-muted-foreground">{t("outbox.delayHint")}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Input type="number" min={0} max={120} value={settings.delaySec}
            onChange={(e) => void setSettings({ delaySec: Math.max(0, Math.min(120, Number(e.target.value) || 0)) })}
            className="h-8 w-20 text-right" />
          <span className="text-xs text-muted-foreground">s</span>
        </div>
      </div>

      <div className="rounded-lg border border-border p-3">
        <span className="block text-[0.8125rem]">{t("outbox.destination")}</span>
        <ToggleGroup value={[settings.target]} onValueChange={(v) => { const t = v[0]; if (t === "new" || t === "single") void setSettings({ target: t }); }}
          spacing={0} variant="outline" className="mt-2 grid grid-cols-2">
          <ToggleGroupItem value="new" className="text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary">{t("outbox.targetNew")}</ToggleGroupItem>
          <ToggleGroupItem value="single" className="text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary">{t("outbox.targetSingle")}</ToggleGroupItem>
        </ToggleGroup>
        {settings.target === "single" && (
          <Input value={settings.targetName} onChange={(e) => void setSettings({ targetName: e.target.value })}
            placeholder={t("outbox.targetPlaceholder")} className="mt-2 h-8 text-sm" />
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          {settings.target === "single"
            ? t("outbox.targetSingleHint") : t("outbox.targetNewHint")}
        </p>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[0.8125rem] font-medium">{t("outbox.queue")} {pending.length ? <span className="text-muted-foreground">· {t("outbox.pendingCount", { count: pending.length })}</span> : null}</h3>
          <div className="flex gap-1.5">
            {!!pending.length && <Button size="sm" variant="outline" onClick={() => void flush("resolve")}><Play className="size-3.5" /> {t("outbox.applyNow")}</Button>}
            {entries.length > 0 && <Button size="sm" variant="ghost" onClick={() => void clear("done")}><Trash2 className="size-3.5" /> {t("outbox.clearHistory")}</Button>}
          </div>
        </div>
        {entries.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">{t("outbox.empty")}</p>
        ) : (
          <div className="space-y-1">
            {entries.map((e) => (
              <div key={e.id} className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs">
                {e.status === "done" ? <Check className="size-3.5 shrink-0 text-[var(--color-ok)]" />
                  : e.status === "error" ? <CircleAlert className="size-3.5 shrink-0 text-destructive" />
                  : <Clock className="size-3.5 shrink-0 text-[var(--color-warn)]" />}
                <span className="min-w-0 flex-1 truncate">{e.label}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{hostShort(e.host)}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {e.status === "done" ? (e.result ? `« ${e.result} »` : t("outbox.applied")) : e.status === "error" ? (e.error || t("outbox.failed")) : t("outbox.pending")}
                </span>
                <button type="button" aria-label={t("common:action.remove")} onClick={() => void remove(e.id)} className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"><X className="size-3.5" /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
