import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download } from "lucide-react";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectSeparator,
} from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useTranslation } from "react-i18next";
import { isModelCompatible, useCompatibility } from "@/hooks/useCompatibility";
import { coreAvailable } from "@/lib/coreClient";

// Source unique des sélecteurs de modèle (traitements + Roto Studio) : on ne liste QUE les modèles
// réellement installés, suivis d'une entrée permanente « Télécharger d'autres modèles… » qui ouvre
// Paramètres › Modèles. Sans cette entrée, un premier lancement afficherait une liste vide et sans
// issue (les poids d'upscale ne sont pas fournis avec l'app).

// Valeur sentinelle de l'entrée de téléchargement : interceptée avant `onChange`, donc JAMAIS écrite
// dans les réglages.
const MORE = "__nr_more_models__";
const SHARED_RUNTIME: Record<string, string> = {
  "rife-v4.6": "rife-ncnn-vulkan",
  "rife-v4": "rife-ncnn-vulkan",
  "rife-anime": "rife-ncnn-vulkan",
  "rife-HD": "rife-ncnn-vulkan",
  "rife-UHD": "rife-ncnn-vulkan",
};

// Ouvre Paramètres › IA › Modèles (même chemin que openExportSettings/openConsole du slice coquille).
export function openModelsPage() {
  useApp.getState().openSettings("ai", "models");
}

export interface InstalledModels {
  /** Le statut réel est connu (liste chargée depuis le core). Faux hors Tauri (mock = liste vide). */
  ready: boolean;
  /** Ce modèle est-il utilisable maintenant ? */
  has: (id: string) => boolean;
}

// Ids des modèles installés, rafraîchis à la fin d'un téléchargement (SSE models:progress) → un
// modèle tiré depuis Paramètres › Modèles devient sélectionnable sans relancer l'app.
export function useInstalledModels(): InstalledModels {
  const [ids, setIds] = useState<Set<string> | null>(null);

  useEffect(() => {
    let on = true;
    const load = () => {
      nr.modelsList().then((r) => {
        if (!on || !r.ok) return;
        setIds(new Set(r.models.filter((m) => m.installed && !m.partial).map((m) => m.id)));
      }).catch(() => { /* le sélecteur reste fermé plutôt que de proposer des poids absents */ });
    };
    load();
    const off = nr.onModelsProgress((p) => { if (p.stage === "done") load(); });
    return () => { on = false; off(); };
  }, []);

  const has = useCallback((id: string) => {
    if (!coreAvailable) return true; // mock navigateur : garde une UI démontrable sans backend
    if (!ids) return false;          // Tauri : le core est l'autorité, aucun faux modèle au boot
    return ids.has(SHARED_RUNTIME[id] ?? id);
  }, [ids]);

  return { ready: ids != null, has };
}

// Un réglage persisté peut viser un modèle supprimé ou une installation incomplète. Le statut est
// renvoyé au composant, mais la navigation reste toujours sous le contrôle de l'utilisateur.
export function useRequireModel(id: string, enabled = true) {
  const { ready, has } = useInstalledModels();
  return { ready, missing: enabled && ready && !!id && !has(id) };
}

// Options d'un sélecteur = modèles disponibles seulement. Si la valeur courante n'est plus installée,
// le sélecteur affiche l'installation directe au lieu de modifier silencieusement le réglage.
export function useModelOptions<T extends { id: string }>(
  all: readonly T[], value: string, required = true,
): T[] {
  const { has } = useInstalledModels();
  const { status } = useCompatibility();
  // Conserve la valeur courante dans le sélecteur même si son runtime manque : la page reste
  // compréhensible et le pied compact mène explicitement vers Paramètres › Modèles.
  const opts = useMemo(() => all.filter((m) => (m.id === value || has(m.id)) && isModelCompatible(m.id, status)), [all, has, status, value]);
  useRequireModel(value, required);
  return opts;
}

// Aucun modèle installé pour cette op → lien explicite vers le catalogue (jamais de navigation auto).
export function ModelsCta({ label, disabled }: { label?: string; disabled?: boolean }) {
  const { t } = useTranslation("upscale");
  return (
    <div className="space-y-1.5 rounded-md border border-dashed border-border p-2">
      {label && <p className="text-[11px] leading-snug text-muted-foreground">{label}</p>}
      <Button variant="outline" size="sm" className="w-full" onClick={openModelsPage} disabled={disabled}>
        <Download className="h-3.5 w-3.5" /> {t("modelPicker.download")}
      </Button>
    </div>
  );
}

// Sélecteur de modèle : options installées + entrée de téléchargement en pied de liste.
// L'option ne porte QUE le nom exact du modèle ; l'usage vit dans l'infobulle (`hint`) — les noms de
// modèles ne disent pas à quoi ils servent, mais un libellé maison ne dit pas quel modèle tourne.
// `itemExtra` = décoration par option (badge NC des moteurs roto).
export function ModelPicker({ items, value, onChange, disabled, className, empty, itemExtra }: {
  items: readonly { id: string; label: string; hint?: string }[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  className?: string;                              // classes du déclencheur (défaut : pleine largeur)
  empty?: string;                                  // message quand rien n'est installé
  itemExtra?: (id: string) => React.ReactNode;
}) {
  const { t } = useTranslation("upscale");
  const cur = items.find((m) => m.id === value);
  const { ready, has } = useInstalledModels();
  const missing = ready && !has(value);
  if (!cur) return <ModelsCta label={empty} disabled={disabled} />;
  const hint = cur?.hint ? t([`modelHint.${cur.id}`, `depthModelHint.${cur.id}`, `segModelHint.${cur.id}`], { defaultValue: cur.hint }) : undefined;
  const rootItems = [
    ...items.map((m) => ({ value: m.id, label: m.label })),
    { value: MORE, label: t("modelPicker.more") },
  ];
  const trigger = (
    <SelectTrigger className={className ?? "w-full"}>
      <SelectValue>{cur?.label ?? value}</SelectValue>
    </SelectTrigger>
  );
  return (
    <div className="space-y-1">
      <Select
        value={value}
        onValueChange={(v) => { const id = String(v); if (id === MORE) openModelsPage(); else onChange(id); }}
        items={rootItems}
        disabled={disabled}
      >
        {hint ? (
          <Tooltip>
            <TooltipTrigger render={trigger} />
            <TooltipContent>{hint}</TooltipContent>
          </Tooltip>
        ) : trigger}
        <SelectContent>
          {items.map((m) => (
            <SelectItem key={m.id} value={m.id} disabled={missing && m.id === value}>
              {itemExtra ? (
                <span className="flex items-center gap-2">{m.label}{itemExtra(m.id)}</span>
              ) : m.label}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={MORE} className="text-muted-foreground">
            <span className="flex items-center gap-2"><Download className="h-3.5 w-3.5" /> {t("modelPicker.more")}</span>
          </SelectItem>
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
