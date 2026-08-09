import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clapperboard, Check, AlertTriangle, CircleAlert } from "lucide-react";
import { nr, type Clip, type DetectModel } from "@/lib/bridge";
import { useApp } from "@/store";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { MODELS } from "./cutStudioShared";
import { DetectionModelSelect } from "./DetectionControls";

type Dest = "new" | "append";

// Découpe en cache d'un modèle : nombre de plans (null = pas encore découpé avec ce modèle).
type CacheState = Record<DetectModel, number | null>;

// Envoi des plans DÉCOUPÉS d'un rush vers la timeline : choix du modèle (déjà calculé),
// nouvelle timeline ou timeline ouverte, et nom. Lit les caches des modèles sans relancer
// la détection → propose seulement les découpes réellement disponibles.
export function TimelineSendDialog({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  const { t } = useTranslation(["derush", "common"]);
  const sendToTimeline = useApp((s) => s.sendToTimeline);
  const base = useMemo(() => clip.name.replace(/\.[^.]+$/, ""), [clip.name]);

  const [cache, setCache] = useState<CacheState | null>(null);
  // Part du modèle de découpe choisi dans les réglages, pas d'un défaut en dur.
  const [model, setModel] = useState<DetectModel>(useApp.getState().searchCutModel);
  const [dest, setDest] = useState<Dest>("new");
  const [name, setName] = useState(t("shared.defaultDerushName", { name: base }));
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);

  // Sonde les caches des modèles en parallèle (sans charger les modèles).
  useEffect(() => {
    let alive = true;
    Promise.all(MODELS.map((m) => nr.cachedScenes(clip.path, m.id).catch(() => null)))
      .then((res) => {
        if (!alive) return;
        const next = { transnetv2: null, omnishotcut: null, autoshot: null } as CacheState;
        MODELS.forEach((m, i) => {
          const r = res[i];
          next[m.id] = r && r.cached && r.scenes.length ? r.scenes.length : null;
        });
        setCache(next);
        const firstCut = MODELS.find((m) => next[m.id] != null);
        if (firstCut) setModel(firstCut.id);
      });
    return () => { alive = false; };
  }, [clip.path]);

  const cutCount = cache ? cache[model] : null;
  const ready = !sending && cache != null && cutCount != null;

  async function confirm() {
    setSending(true);
    setResult(null);
    // Le résultat s'affiche DANS la modale (la fenêtre plugin reste au-dessus de Resolve ;
    // un toast en bas passerait inaperçu). On ne ferme pas tant que l'utilisateur n'a pas vu.
    try { setResult(await sendToTimeline({ clip, mode: dest, name, model })); }
    finally { setSending(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !sending) onClose(); }}>
      <DialogContent className="w-[820px] max-w-[calc(100%-2rem)] gap-6 p-7">
        <div className="min-w-0 space-y-1">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Clapperboard className="h-4 w-4 shrink-0 text-primary" /> {t("mediaTree.sendToTimeline")}
          </DialogTitle>
          <Tooltip>
            <TooltipTrigger render={<DialogDescription className="truncate" />}>
              {clip.name}
            </TooltipTrigger>
            <TooltipContent>{clip.name}</TooltipContent>
          </Tooltip>
        </div>

        {/* Modèle de découpe : seuls ceux qui ont une découpe en cache sont activables */}
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("shared.cutModel")}</Label>
          {cache == null ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" /> {t("sendDialog.readingCuts")}
            </div>
          ) : (
            <DetectionModelSelect
              model={model}
              onChange={setModel}
              className="w-56"
              isModelDisabled={(id) => cache[id] == null}
              detail={(id) => cache[id] != null
                ? t("shared.shotsCount", { count: cache[id] })
                : t("shared.notCut")}
            />
          )}
          {cache != null && MODELS.every((entry) => cache[entry.id] == null) && (
            <p className="text-xs text-[var(--color-warn)]">{t("sendDialog.notCutHint")}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("sendDialog.destination")}</Label>
          <ToggleGroup
            value={[dest]}
            onValueChange={(v) => { const n = v[0] as Dest | undefined; if (n) setDest(n); }}
            spacing={0}
            variant="outline"
            className="grid grid-cols-2"
          >
            <ToggleGroupItem value="new" className="text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary">
              {t("target.newTimeline")}
            </ToggleGroupItem>
            <ToggleGroupItem value="append" className="text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary">
              {t("target.openedTimeline")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {/* Nom (timeline créée ; en mode ouverte, sert de repli si aucune n'est ouverte) */}
        <div className="space-y-2">
          <Label htmlFor="tl-name" className="text-xs text-muted-foreground">
            {dest === "new" ? t("sendDialog.nameLabel") : t("sendDialog.nameLabelAppend")}
          </Label>
          <Input id="tl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("shared.defaultDerushName", { name: base })} />
        </div>

        {/* Résultat de l'envoi, affiché dans la modale (sinon invisible derrière Resolve) */}
        {result && (
          <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${
            result.kind === "ok" ? "border-[var(--color-ok)]/40 text-foreground"
              : result.kind === "warn" ? "border-amber-500/50 text-foreground"
              : "border-destructive/50 text-foreground"}`}>
            {result.kind === "ok" ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-ok)]" />
              : result.kind === "warn" ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
            <span className="min-w-0 flex-1">{result.text}</span>
          </div>
        )}

        <DialogFooter>
          {result && result.kind !== "err" ? (
            <Button onClick={onClose}>{t("common:action.close")}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={sending}>{t("common:action.cancel")}</Button>
              <Button onClick={confirm} disabled={!ready}>
                {sending && <Spinner className="size-4" />}
                {result?.kind === "err" ? t("common:action.retry")
                  : cutCount != null ? t("sendDialog.sendN", { count: cutCount }) : t("sendDialog.send")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
