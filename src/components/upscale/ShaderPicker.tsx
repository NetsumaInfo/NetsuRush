import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ShaderModel } from "@/lib/bridge";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { isModelCompatible, useCompatibility } from "@/hooks/useCompatibility";
import { openModelsPage, useInstalledModels } from "./ModelPicker";
import { SHADER_MODELS, isRtxShader, RTX_RUNTIME_IDS } from "./upscaleShared";

// Sélecteur du panier « temps réel ». Les noms de modèles ne disent pas à quoi ils servent (« C4F32
// DS ») : chaque option porte donc son usage en infobulle, comme le ModelPicker du moteur IA. Un
// modèle sans matériel compatible (RTX VSR hors NVIDIA) n'est pas listé — le proposer pour échouer
// au lancement ne renseigne personne.
export function ShaderPicker({ value, onChange, disabled }: {
  value: ShaderModel;
  onChange: (shader: ShaderModel) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("upscale");
  const { status } = useCompatibility();
  const items = useMemo(
    () => SHADER_MODELS.filter((m) => m.id === value || isModelCompatible(m.id, status)),
    [status, value],
  );
  const current = items.find((m) => m.id === value) ?? items[0];
  const hintOf = (m: { id: string; hint: string }) => t(`shaderHint.${m.id}`, { defaultValue: m.hint });
  // Les shaders GLSL sont livrés avec l'app ; seul RTX VSR dépend d'un runtime à installer. Il reste
  // listé même absent (sinon il serait indécouvrable) et renvoie vers le gestionnaire de modèles.
  const { ready, has } = useInstalledModels();
  const missing = isRtxShader(value) && ready && !RTX_RUNTIME_IDS.every(has);

  return (
    <div className="space-y-1">
      <Select value={value} onValueChange={(v) => v && onChange(String(v) as ShaderModel)}
        items={items.map((m) => ({ value: m.id, label: m.label }))} disabled={disabled}>
        <Tooltip>
          <TooltipTrigger render={<SelectTrigger className="w-full"><SelectValue>{current?.label ?? value}</SelectValue></SelectTrigger>} />
          {current && <TooltipContent>{hintOf(current)}</TooltipContent>}
        </Tooltip>
        <SelectContent>
          {items.map((m) => (
            <Tooltip key={m.id}>
              <TooltipTrigger render={<SelectItem value={m.id}>{m.label}</SelectItem>} />
              <TooltipContent side="right">{hintOf(m)}</TooltipContent>
            </Tooltip>
          ))}
        </SelectContent>
      </Select>
      {missing && (
        <button type="button" onClick={openModelsPage} className="flex w-full items-center gap-1 text-left text-[11px] text-muted-foreground hover:text-foreground">
          <AlertTriangle className="size-3 shrink-0 text-[var(--color-warn)]" />
          <span>{t("modelPicker.required")}</span>
          <span className="ml-auto shrink-0 underline underline-offset-2">{t("modelPicker.settings")}</span>
        </button>
      )}
    </div>
  );
}
