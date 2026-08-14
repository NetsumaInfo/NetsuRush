// Popup d'upscale d'un item média du board : choix modèle + échelle → APERÇU avant/après (slider
// wipe) → Valider. Image : l'aperçu EST l'upscale final (réutilisé au Valider, sinon asset nettoyé).
// Vidéo : l'aperçu = test sur UNE frame (rapide) ; le Valider lance l'upscale du clip entier.
// Non destructif : l'ancien média est gardé dans `prevMedia` (revert depuis l'Inspector).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Wand2, Eye } from "lucide-react";
import { nr } from "@/lib/bridge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { UpscaleCompare } from "@/components/upscale/UpscaleCompare";
import type { FrameCompare } from "@/components/upscale/useUpscale";
import { UP_SCALES } from "@/components/upscale/upscaleShared";
import { ModelsCta } from "@/components/upscale/ModelPicker";
import { displaySrc, type BoardItem } from "./referenceShared";
import { MiniSelect } from "./inspectorControls";
import { useBoard } from "./useReferenceBoard";
import { useBoardUpChoices } from "./useBoardUpChoices";
import { applyUpscaled, canPreviewUpscale, ensureLocalMedia, upscaleChoiceFrom } from "./boardUpscale";

export function UpscaleItemDialog({
  item,
  open,
  onOpenChange,
}: {
  item: BoardItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation("reference");
  const prefs = useBoard((s) => s.prefs);
  const isVideo = item.kind === "video";
  // Sélecteur unifié « Modèle » : id d'un modèle IA OU d'un shader Turbo, par vrai nom. Défaut = board.
  const [sel, setSel] = useState<string>(isVideo && prefs.upEngine === "turbo" ? prefs.upShader : prefs.upModel);
  const [scale, setScale] = useState<1 | 2 | 4>(prefs.upScale);
  const [denoise, setDenoise] = useState(prefs.upDenoise);
  const [busy, setBusy] = useState(false);        // upscale final (Valider) en cours
  const [previewing, setPreviewing] = useState(false);
  const [preparing, setPreparing] = useState(false); // récupération d'un fichier local (média distant/extrait)
  const [localRef, setLocalRef] = useState<string | null>(null); // fichier local résolu (mémoïsé)
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FrameCompare | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null); // image : asset déjà produit (réutilisé)

  // Un shader Turbo = VIDÉO uniquement → sur une image la liste ne montre que les modèles IA.
  const choice = upscaleChoiceFrom(sel, prefs, isVideo, denoise, scale);
  const { ready: modelsReady, choices } = useBoardUpChoices(isVideo ? "video" : "image");
  useEffect(() => {
    if (modelsReady && choices.length && !choices.some((c) => c.value === sel)) setSel(choices[0].value);
  }, [modelsReady, choices, sel]);
  const selected = choices.find((c) => c.value === sel);
  const modelHint = selected
    ? t([`modelHint.${sel}`, `shaderHint.${sel}`], { ns: "upscale", defaultValue: selected.hint })
    : null;

  // Progression du sidecar (vidéo : encode frame par frame ; image : quasi instantané).
  useEffect(() => {
    if (!busy || !isVideo) return;
    return nr.onUpscaleProgress((p) => setPct(p.pct));
  }, [busy, isVideo]);

  // Change de modèle/échelle ⇒ l'aperçu devient obsolète : on le jette (et on nettoie l'asset image).
  function clearPreview() {
    if (previewPath) void nr.reference?.dropAsset(previewPath);
    setPreviewPath(null);
    setPreview(null);
  }
  useEffect(() => {
    clearPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, scale, denoise]);

  // Débruitage réglable uniquement sur les modèles IA qui le gèrent (ex. « Réel léger »).
  const denoisable = choice.denoise !== undefined;
  // Seul RTX VSR (CLI fichier entier) ne sait pas rendre une image de test.
  const canPreview = canPreviewUpscale(choice);

  // Média DISTANT/extrait (ref http) → fichier local résolu une fois puis mémoïsé.
  async function ensureLocal(): Promise<string | null> {
    if (localRef) return localRef;
    setPreparing(true);
    try {
      const p = await ensureLocalMedia(item.ref);
      if (p) setLocalRef(p);
      return p;
    } finally {
      setPreparing(false);
    }
  }

  function applyMedia(path: string) {
    applyUpscaled(item, path);
    setPreviewPath(null); // adopté : ne pas le supprimer à la fermeture
    onOpenChange(false);
  }

  async function genPreview() {
    const ref = nr.reference;
    if (!ref) return setError(t("upscale.moduleUnavailable"));
    setPreviewing(true);
    setError(null);
    try {
      const input = await ensureLocal();
      if (!input) return setError(t("upscale.remoteFail"));
      if (isVideo) {
        const at = item.trimIn ?? 0;
        const r = await nr.upscaleTestFrame({
          input, time: at, engine: choice.engine, model: choice.model, shader: choice.shader,
          scale: choice.scale, denoise: choice.denoise,
        });
        if (!r.ok || !r.out || !r.orig) return setError(r.error || t("upscale.previewFail"));
        setPreview({ origUrl: nr.mediaUrl(r.orig), outUrl: nr.mediaUrl(r.out), width: r.width || 0, height: r.height || 0, time: at });
      } else {
        const r = await ref.upscaleItem({ path: input, kind: "image", model: choice.model, scale: choice.scale, denoise: choice.denoise });
        if (!r.ok || !r.path) return setError(r.error || t("upscale.previewFail"));
        setPreviewPath(r.path);
        setPreview({ origUrl: item.src, outUrl: displaySrc("image", r.path), width: r.width || 0, height: r.height || 0, time: 0 });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function validate() {
    // Image déjà upscalée pour l'aperçu → on réutilise le fichier (pas de re-calcul).
    if (!isVideo && previewPath) return applyMedia(previewPath);
    const ref = nr.reference;
    if (!ref) return setError(t("upscale.moduleUnavailable"));
    setBusy(true);
    setError(null);
    setPct(isVideo ? 0 : null);
    try {
      const input = await ensureLocal();
      if (!input) return setError(t("upscale.remoteFail"));
      const r = await ref.upscaleItem({
        path: input, kind: isVideo ? "video" : "image",
        in: item.trimIn, out: item.trimOut,
        engine: choice.engine, model: choice.model, shader: choice.shader, scale: choice.scale, denoise: choice.denoise,
      });
      if (!r.ok || !r.path) return setError(r.error || t("upscale.upscaleFail"));
      applyMedia(r.path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (busy || previewing) return;
    clearPreview();
    onOpenChange(false);
  }

  const working = busy || previewing || preparing;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="size-4" /> {t("upscale.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">{t("upscale.model")}</span>
            <div className={working ? "pointer-events-none opacity-60" : ""}>
              {choices.length ? (
                // Le nom d'un modèle ne dit pas à quoi il sert : son usage vit dans l'infobulle,
                // comme dans le sélecteur du panneau Traitements.
                <Tooltip>
                  <TooltipTrigger render={<div className="w-full" />}>
                    <MiniSelect
                      ariaLabel={t("upscale.modelAria")} className="w-full"
                      value={sel}
                      onChange={setSel}
                      items={choices.map((c) => ({ value: c.value, label: c.label }))}
                    />
                  </TooltipTrigger>
                  <TooltipContent>{modelHint}</TooltipContent>
                </Tooltip>
              ) : (
                <ModelsCta label={t("upscale.noModel")} disabled={working} />
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">{t("upscale.scale")}</span>
            <ToggleGroup value={[String(scale)]} onValueChange={(v) => v[0] && setScale(Number(v[0]) as 1 | 2 | 4)}>
              {UP_SCALES.map((s) => (
                <ToggleGroupItem key={s} value={String(s)} disabled={working}>{s}×</ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          {/* Débruitage (modèles qui le gèrent, ex. « Réel léger ») — petit slider 0–100 %. */}
          {denoisable && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t("upscale.denoise")}</span>
                <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{Math.round(denoise * 100)} %</span>
              </div>
              <Slider
                value={[Math.round(denoise * 100)]}
                min={0} max={100} step={5} disabled={working}
                onValueChange={(v) => setDenoise((Array.isArray(v) ? v[0] : v) / 100)}
              />
            </div>
          )}

          {/* Aperçu avant/après (slider wipe) */}
          {preview && <UpscaleCompare data={preview} onClose={clearPreview} compact />}

          {preparing && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="h-4 w-4" /> {t("upscale.fetchingLocal")}
            </p>
          )}
          {previewing && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="h-4 w-4" /> {isVideo ? t("upscale.genPreviewVideo") : t("upscale.genPreviewImage")}
            </p>
          )}
          {busy && isVideo && <Progress value={pct ?? 0} />}
          {busy && !isVideo && <p className="text-xs text-muted-foreground">{t("upscale.upscaling")}</p>}
          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={close} disabled={working}>{t("common:action.cancel")}</Button>
            {canPreview && !preview && (
              <Button variant="outline" onClick={genPreview} disabled={working || !choices.length}>
                <Eye className="size-4" /> {t("upscale.preview")}
              </Button>
            )}
            <Button onClick={validate} disabled={working || !choices.length}>
              {busy ? t("upscale.working") : t("upscale.validate")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
