import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { updaterAvailable, useUpdater } from "@/store/updater";
import { updateStatusKey } from "@/components/updates/UpdateStatusLine";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Mise à jour en UN bouton. L'updater passe par le plugin Tauri : il fonctionne même quand le core
 * Node est mort (« core indisponible : Failed to fetch »), c'est-à-dire exactement quand l'écran
 * d'installation est le seul atteignable. Sans lui, un utilisateur bloqué devrait DÉSINSTALLER
 * l'application pour repartir sur une version corrigée.
 *
 * N'apparaît QUE lorsqu'une version existe vraiment. La recherche est silencieuse : « à jour »,
 * « recherche… » et les échecs (dépôt privé, réseau coupé) ne sont pas des informations que
 * quelqu'un vient chercher — un bouton présent en permanence ne fait qu'ajouter du bruit.
 *
 * La variante `icon` vit dans la barre de titre, à gauche des boutons système : c'est le MÊME
 * endroit à l'installation (GateFrame) et dans l'application (Shell), donc un seul réflexe à
 * apprendre au lieu d'un bouton qui change de place selon l'écran.
 */
export function UpdateButton({ className, variant = "action" }: { className?: string; variant?: "action" | "icon" }) {
  const { t } = useTranslation(["setup", "settings"]);
  const phase = useUpdater((state) => state.phase);
  const info = useUpdater((state) => state.info);
  const autoCheck = useUpdater((state) => state.autoCheck);
  const check = useUpdater((state) => state.check);
  const install = useUpdater((state) => state.install);
  const busy = phase === "checking" || phase === "downloading";

  // Sonde au montage : l'utilisateur ne doit pas avoir à deviner qu'un correctif existe, surtout
  // quand l'écran affiché est déjà un écran de panne. Le réglage « vérification automatique » reste
  // respecté.
  useEffect(() => {
    if (autoCheck && useUpdater.getState().phase === "idle") void check();
  }, [autoCheck, check]);

  // Rien à proposer : ni bouton, ni place occupée. `downloading` reste affiché, sinon l'action
  // disparaîtrait sous le doigt de celui qui vient de cliquer.
  if (!updaterAvailable() || (phase !== "available" && phase !== "downloading")) return null;

  const label = t("setup:update.download");
  const status = t(updateStatusKey(phase), { ns: "settings", version: info?.version });

  if (variant === "icon") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              disabled={busy}
              onClick={() => void install()}
              className={`inline-flex h-9 w-11 items-center justify-center text-primary outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-70 [&_svg]:size-3.5 ${className ?? ""}`}
            />
          }
        >
          <Download className={busy ? "animate-pulse" : undefined} />
        </TooltipTrigger>
        <TooltipContent>{label} — {status}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button size="sm" className={className} disabled={busy} onClick={() => void install()} />}
      >
        <Download className={busy ? "size-3.5 animate-pulse" : "size-3.5"} /> {t("setup:update.action")}
      </TooltipTrigger>
      <TooltipContent>{status}</TooltipContent>
    </Tooltip>
  );
}
