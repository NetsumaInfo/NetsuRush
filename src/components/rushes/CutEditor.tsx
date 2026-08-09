import { memo, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Scissors, Check, CircleAlert, ChevronLeft, Combine, Trash2, RotateCcw, Film } from "lucide-react";
import { nr, type CutAnalysis, type CutClip } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { LazyThumb } from "./LazyThumb";
import { fmt } from "./cutStudioShared";

type BuildRes = { ok: boolean; timeline?: string; shots?: number; error?: string } | null;

const clone = (clips: CutClip[]): CutClip[] => clips.map((c) => ({ ...c, shots: c.shots.map((s) => ({ ...s })) }));
const fpsDec = (c: CutClip) => c.fpsNum || (c.fps.den ? c.fps.num / c.fps.den : 24) || 24;

// Chip d'un plan, mémoïsée : un toggle de sélection ne re-rend que la chip concernée, pas les
// centaines d'autres de la timeline. `onToggle` (recréé à chaque rendu parent, setState fonctionnel
// → sémantique stable) est volontairement ignoré par le comparateur.
const ShotChip = memo(function ShotChip({ path, at, num, dur, on, busy, onToggle }: {
  path: string; at: number; num: number; dur: string; on: boolean; busy: boolean; onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      className={`group relative w-[104px] overflow-hidden rounded-md border text-left ${
        on ? "border-primary ring-1 ring-primary" : "border-border hover:border-primary/40"}`}
    >
      <LazyThumb path={path} at={at} className="aspect-video w-full" />
      <div className="flex items-center justify-between gap-1 px-1.5 py-1 text-[10px] tabular-nums">
        <span className="text-muted-foreground">#{num}</span>
        <span className="text-foreground/80">{dur}</span>
      </div>
      {on && <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="size-2.5" /></span>}
    </button>
  );
}, (a, b) => a.path === b.path && a.at === b.at && a.num === b.num && a.dur === b.dur && a.on === b.on && a.busy === b.busy);

// Éditeur de coupes in-app : sur la structure analysée (plans SOURCE par rush), on fusionne les plans
// adjacents (= supprimer une coupe, les rushs se rejoignent) ou on supprime des plans, PUIS on construit
// la timeline finale (FCPXML → through-edits natifs, l'originale reste intacte). Rien n'est envoyé à
// Resolve avant « Construire ».
export function CutEditor({ analysis, onBack, onClose, mode, onBuild }: {
  analysis: CutAnalysis;
  onBack: () => void;
  onClose: () => void;
  mode?: "new" | "replace";
  // Monteur de remplacement : `buildCutTimeline` est le flux FCPXML de Resolve. Sur hôte Adobe, la
  // vue passe son propre monteur (job du panneau CEP) — l'édition des coupes ne change pas.
  onBuild?: (clips: CutClip[], name?: string) => Promise<BuildRes>;
}) {
  const { t } = useTranslation(["derush", "common"]);
  const [clips, setClips] = useState<CutClip[]>(() => clone(analysis.clips));
  const [name, setName] = useState(analysis.base ?? (analysis.source ? t("cutTimeline.defaultName", { name: analysis.source }) : t("cutTimeline.defaultName", { name: t("shared.timelineFallback") })));
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<number | null>(null);
  const [res, setRes] = useState<BuildRes>(null);
  const offRef = useRef<(() => void) | null>(null);

  const key = (ci: number, si: number) => `${ci}:${si}`;
  const total = useMemo(() => clips.reduce((a, c) => a + c.shots.length, 0), [clips]);
  const selCount = sel.size;
  // Fusion possible seulement si ≥2 plans sélectionnés ADJACENTS dans un même rush.
  const canMerge = useMemo(() => {
    const byClip = new Map<number, number[]>();
    for (const k of sel) { const [ci, si] = k.split(":").map(Number); (byClip.get(ci) ?? byClip.set(ci, []).get(ci)!).push(si); }
    for (const idxs of byClip.values()) {
      idxs.sort((a, b) => a - b);
      for (let i = 1; i < idxs.length; i++) if (idxs[i] === idxs[i - 1] + 1) return true;
    }
    return false;
  }, [sel]);

  const toggle = (ci: number, si: number) => setSel((s) => { const n = new Set(s); const k = key(ci, si); n.has(k) ? n.delete(k) : n.add(k); return n; });

  // Fusionne chaque run de plans adjacents sélectionnés d'un rush en un seul (frames source cumulés).
  function mergeSel() {
    setClips((prev) => prev.map((c, ci) => {
      const idxs = c.shots.map((_, si) => si).filter((si) => sel.has(key(ci, si)));
      if (idxs.length < 2) return c;
      const shots = c.shots.slice();
      const runs: number[][] = [];
      let run: number[] = [];
      for (const si of idxs) {
        if (run.length && si === run[run.length - 1] + 1) run.push(si);
        else { if (run.length) runs.push(run); run = [si]; }
      }
      if (run.length) runs.push(run);
      for (const r of runs.reverse()) {                    // de la fin → pas de décalage d'indices
        if (r.length < 2) continue;
        const [first] = r;
        const last = r[r.length - 1];
        const startFrame = shots[first].startFrame;
        const frames = shots.slice(first, last + 1).reduce((a, s) => a + s.frames, 0);
        shots.splice(first, r.length, { startFrame, frames });
      }
      return { ...c, shots };
    }));
    setSel(new Set());
  }

  function deleteSel() {
    setClips((prev) => prev.map((c, ci) => ({ ...c, shots: c.shots.filter((_, si) => !sel.has(key(ci, si))) })));
    setSel(new Set());
  }

  function reset() { setClips(clone(analysis.clips)); setSel(new Set()); }

  async function build() {
    setBusy(true); setRes(null); setProg(0);
    if (!onBuild) offRef.current = nr.onTimelineCutProgress((p) => setProg(p.pct ?? null));
    try {
      const r = onBuild
        ? await onBuild(clips, name.trim() || undefined)
        : await nr.buildCutTimeline({ name: name.trim() || undefined, source: analysis.source, clips, mode });
      setRes(r);
    } finally {
      offRef.current?.(); offRef.current = null;
      setBusy(false); setProg(null);
    }
  }

  return (
    <div className="flex max-h-[78vh] min-h-0 flex-col">
      {/* En-tête : retour + source + compte de plans + actions d'édition. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-1 pb-3">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={busy} className="gap-1.5">
          <ChevronLeft className="h-4 w-4" /> {t("cutEditor.timelines")}
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{analysis.source}</div>
          <div className="text-[11px] text-muted-foreground">{t("shared.shotsCount", { count: total })}{selCount ? t("cutEditor.selSuffix", { count: selCount }) : ""}</div>
        </div>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="sm" onClick={mergeSel} disabled={!canMerge || busy} className="gap-1.5" />}>
            <Combine className="h-4 w-4" /> {t("shared.merge")}
          </TooltipTrigger>
          <TooltipContent>{t("cutEditor.mergeTip")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="sm" onClick={deleteSel} disabled={!selCount || busy} className="gap-1.5 text-destructive hover:text-destructive" />}>
            <Trash2 className="h-4 w-4" /> {t("common:action.delete")}
          </TooltipTrigger>
          <TooltipContent>{t("cutEditor.deleteTip")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={reset} disabled={busy} aria-label={t("common:action.reset")} />}>
            <RotateCcw className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent>{t("cutEditor.resetTip")}</TooltipContent>
        </Tooltip>
      </div>

      {/* Plans par rush : chip = vignette du 1er cadre + n° + durée. Clic = sélectionner. */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-3 pr-1">
        {clips.map((c, ci) => (
          <div key={`${c.path}-${ci}`} className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Film className="h-3 w-3 shrink-0" />
              <span className="truncate">{c.name}</span>
              <span className="shrink-0 opacity-60">· {t("shared.shotsCount", { count: c.shots.length })}</span>
            </div>
            {c.shots.length === 0 ? (
              <p className="pl-4 text-[11px] italic text-muted-foreground/70">{t("cutEditor.rushRemoved")}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {c.shots.map((s, si) => (
                  <ShotChip
                    key={si}
                    path={c.path}
                    at={s.startFrame / fpsDec(c)}
                    num={si + 1}
                    dur={fmt(s.frames / fpsDec(c))}
                    on={sel.has(key(ci, si))}
                    busy={busy}
                    onToggle={() => toggle(ci, si)}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Pied : nom + build + progression/résultat. */}
      <div className="shrink-0 space-y-3 border-t border-border pt-3">
        <div className="space-y-1.5">
          <Label htmlFor="cut-editor-name" className="text-xs text-muted-foreground">{t("cutEditor.nameLabel")}</Label>
          <Input id="cut-editor-name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </div>

        {busy && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" /> {t("cutEditor.building")}</div>
            <Progress value={prog} />
          </div>
        )}

        {res && (
          <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${res.ok ? "border-[var(--color-ok)]/40" : "border-destructive/50"}`}>
            {res.ok ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-ok)]" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
            <span className="min-w-0 flex-1">{res.ok ? t("cutEditor.created", { name: res.timeline, count: res.shots }) : (res.error || t("shared.failed"))}</span>
          </div>
        )}

        <div className="flex justify-end gap-2">
          {res?.ok ? (
            <Button onClick={onClose}>{t("common:action.close")}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onBack} disabled={busy}>{t("common:action.back")}</Button>
              <Button onClick={build} disabled={busy || total === 0}>
                {busy && <Spinner className="size-4" />}
                <Scissors className="h-4 w-4" /> {t("cutEditor.build", { count: total })}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
