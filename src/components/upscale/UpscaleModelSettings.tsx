// Réglages de MODÈLE d'upscale (mode, moteur, modèle/shader, échelle, débruitage, nettoyage, experts).
// Extrait de UpscaleSettings pour être partagé : le panneau Traitements ET l'upscale à l'archivage des
// collections rendent EXACTEMENT les mêmes contrôles. Recopier ce bloc ferait diverger les deux écrans
// au premier réglage ajouté. Ce qui reste propre à Traitements (encodage de sortie, dossier, import)
// n'est pas ici : l'archivage a déjà les siens.
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import { Row, Field } from "./procSettingsParts";
import { ModelPicker, useModelOptions } from "./ModelPicker";
import { ShaderPicker } from "./ShaderPicker";
import { ShaderAdvanced, RtxAdvanced } from "./turboAdvanced";
import {
  UP_MODELS, RESTORE_MODELS, UP_SCALES, UP_TILES, UP_TILEPAD, UP_PREPAD,
  UP_DENOISE, nearestDenoise, UP_CLEANUP, shaderRuntimeModel, isRtxShader, modelCaps,
  type UpSettings,
} from "./upscaleShared";

export function UpscaleModelSettings({ settings, patch, disabled }: {
  settings: UpSettings;
  patch: (p: Partial<UpSettings>) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("upscale");
  const [advanced, setAdvanced] = useState(false);
  const isRestore = settings.mode === "restore";
  const isTurbo = !isRestore && settings.engine === "turbo";
  const isModelBackedShader = isTurbo && !!shaderRuntimeModel(settings.shader);
  // RTX VSR sort du SDK NVIDIA : facteur ×2 imposé, et l'encodage est celui du CLI (HEVC 10-bit
  // NVENC), donc ni la parallélisation shader ni le choix d'échelle n'ont de sens ici.
  const isRtx = isTurbo && isRtxShader(settings.shader);
  const choices = isRestore ? RESTORE_MODELS : UP_MODELS;
  // Les réglages affichés suivent le MODÈLE, pas seulement le moteur : chaque réseau a son facteur
  // natif, et un graphe ONNX à dimensions figées n'a ni tuile ni précision à régler.
  const caps = isTurbo ? null : modelCaps(settings.model);
  // Tous les choix Shader sont fournis avec l'app, y compris les deux poids ArtCNN R ONNX.
  const models = useModelOptions(choices, settings.model, !isTurbo);

  return (
    <>
      <Row label={t("settings.rowUpscaleMode")} hint={t(isRestore ? "settings.restoreModeNote" : "settings.upscaleModeNote")}>
        <ToggleGroup value={[settings.mode]} onValueChange={(v) => {
          if (!v[0]) return;
          const mode = v[0] as UpSettings["mode"];
          patch(mode === "restore"
            ? { mode, engine: "ia", scale: 1, model: RESTORE_MODELS[0].id }
            : { mode, scale: 2, model: UP_MODELS[0].id });
        }}>
          <ToggleGroupItem value="upscale" disabled={disabled}>{t("settings.modeUpscale")}</ToggleGroupItem>
          <ToggleGroupItem value="restore" disabled={disabled}>{t("settings.modeRestore")}</ToggleGroupItem>
        </ToggleGroup>
      </Row>
      {!isRestore && (
        <Row label={t("settings.rowEngine")} hint={isTurbo ? t(isRtx ? "settings.rtxNote" : "settings.shaderGpuNote") : undefined}>
          <ToggleGroup value={[settings.engine]} onValueChange={(v) => v[0] && patch({ engine: v[0] as UpSettings["engine"] })}>
            <ToggleGroupItem value="ia" disabled={disabled}>{t("settings.engineAi")}</ToggleGroupItem>
            <ToggleGroupItem value="turbo" disabled={disabled}>{t("settings.engineTurbo")}</ToggleGroupItem>
          </ToggleGroup>
        </Row>
      )}

      {isTurbo ? (
        <>
          <ShaderPicker value={settings.shader} disabled={disabled}
            onChange={(shader) => patch(isRtxShader(shader) ? { shader, scale: 2 } : { shader })} />
          {!isModelBackedShader && !isRtx && (
            <>
              <Row label={t("settings.rowParallelExports")} hint={t("settings.parallelShaderNote")}>
                <Toggle pressed={settings.tParallel} onPressedChange={(p) => patch({ tParallel: p })} disabled={disabled}>
                  {settings.tParallel ? t("settings.yes") : t("settings.no")}
                </Toggle>
              </Row>
              {settings.tParallel && (
                <Row label={t("settings.rowParallelTasks")}>
                  <ToggleGroup value={[String(settings.tConcurrency)]} onValueChange={(v) => v[0] && patch({ tConcurrency: Number(v[0]) as 2 | 3 | 4 })}>
                    {[2, 3, 4].map((n) => <ToggleGroupItem key={n} value={String(n)} disabled={disabled}>{n}</ToggleGroupItem>)}
                  </ToggleGroup>
                </Row>
              )}
            </>
          )}
        </>
      ) : (
        <ModelPicker items={models} value={settings.model} disabled={disabled}
          onChange={(id) => patch({ model: id as UpSettings["model"] })}
          empty={t(isRestore ? "modelPicker.emptyRestore" : "modelPicker.emptyUpscale")} />
      )}

      {!isRestore && (
        <Row
          label={t("settings.rowScale")}
          hint={settings.scale === 1 ? t("settings.scale1Note")
            : caps && settings.scale !== caps.native ? t("settings.scaleResampledNote", { native: caps.native })
              : undefined}
        >
          <ToggleGroup value={[String(settings.scale)]} onValueChange={(v) => v[0] && patch({ scale: Number(v[0]) as 1 | 2 | 4 })}>
            {UP_SCALES.map((s) => (
              <ToggleGroupItem key={s} value={String(s)} disabled={disabled || isRtx}>
                {s}×{caps && s === caps.native ? " ★" : ""}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Row>
      )}
      {caps?.denoise && (
        <Row label={t("settings.rowDenoise")}>
          <Field value={String(nearestDenoise(settings.denoise))} disabled={disabled}
            onChange={(v) => patch({ denoise: Number(v) })}
            items={UP_DENOISE.map((d) => ({ value: String(d.value), label: t(`denoise.${d.value}`, { defaultValue: d.label }) }))} />
        </Row>
      )}
      {!isTurbo && (
        <div className="space-y-3 rounded-md border border-border/70 bg-muted/20 p-3">
          <p className="text-[11px] font-medium text-foreground">{t("settings.cleanupTitle")}</p>
          <Row label={t("settings.rowNoiseCleanup")} hint={t("settings.noiseCleanupNote")}>
            <Field value={String(nearestDenoise(settings.cleanupNoise))} disabled={disabled}
              onChange={(v) => patch({ cleanupNoise: Number(v) })}
              items={UP_CLEANUP.map((d) => ({ value: String(d.value), label: t(`denoise.${d.value}`, { defaultValue: d.label }) }))} />
          </Row>
          <Row label={t("settings.rowEdgeCleanup")} hint={t("settings.edgeCleanupNote")}>
            <Field value={String(nearestDenoise(settings.cleanupEdges))} disabled={disabled}
              onChange={(v) => patch({ cleanupEdges: Number(v) })}
              items={UP_CLEANUP.map((d) => ({ value: String(d.value), label: t(`denoise.${d.value}`, { defaultValue: d.label }) }))} />
          </Row>
        </div>
      )}

      {/* Réglages experts repliés par défaut → panneau épuré. IA = VRAM/précision ; temps réel =
          filtres libplacebo, ou paramètres du RTX Video SDK (les deux n'ont rien en commun). */}
      <button type="button" onClick={() => setAdvanced((a) => !a)}
        className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", advanced && "rotate-90")} /> {t("settings.advanced")}
      </button>

      {isTurbo && advanced && (
        isRtx ? <RtxAdvanced settings={settings} patch={patch} disabled={disabled} />
          : <ShaderAdvanced settings={settings} patch={patch} disabled={disabled} />
      )}
      {advanced && caps && (
        <div className="space-y-3 border-l border-border pl-3">
          {!caps.tile && <p className="text-[11px] text-muted-foreground">{t("settings.windowedModelNote")}</p>}
          {caps.tile && (
            <Row label={t("settings.rowTile")}>
              <Field value={String(settings.tile)} disabled={disabled}
                onChange={(v) => patch({ tile: Number(v) })}
                items={UP_TILES.map((item) => ({ value: String(item.value), label: item.value === 0 ? t("tile.0") : item.label }))} />
            </Row>
          )}
          {caps.tilePad && (
            <Row label={t("settings.rowOverlap")}>
              <Field value={String(settings.tilePad)} disabled={disabled}
                onChange={(v) => patch({ tilePad: Number(v) })}
                items={UP_TILEPAD.map((v) => ({ value: String(v), label: t("settings.px", { n: v }) }))} />
            </Row>
          )}
          {caps.tile && (
            <>
              <Row label={t("settings.rowEdgeMargin")}>
                <Field value={String(settings.prePad)} disabled={disabled}
                  onChange={(v) => patch({ prePad: Number(v) })}
                  items={UP_PREPAD.map((v) => ({ value: String(v), label: t("settings.px", { n: v }) }))} />
              </Row>
              <Row label={t("settings.rowPrecision")} hint={t("settings.precisionNote")}>
                <ToggleGroup value={[settings.fp32 ? "fp32" : "fp16"]} onValueChange={(v) => v[0] && patch({ fp32: v[0] === "fp32" })}>
                  <ToggleGroupItem value="fp16" disabled={disabled}>fp16</ToggleGroupItem>
                  <ToggleGroupItem value="fp32" disabled={disabled}>fp32</ToggleGroupItem>
                </ToggleGroup>
              </Row>
            </>
          )}
        </div>
      )}
    </>
  );
}
