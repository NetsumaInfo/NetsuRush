import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { scheduleUpdateBootstrapCheck, updaterAvailable, useUpdater } from "@/store/updater";
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
 *
 * Le parcours tient en deux clics et ne surprend jamais : icône de téléchargement → pourcentage
 * qui défile → libellé « Mettre à jour » qui redémarre l'application.
 */
export function UpdateButton({ className, variant = "action" }: { className?: string; variant?: "action" | "icon" }) {
  const { t, i18n } = useTranslation(["setup", "settings"]);
  const phase = useUpdater((state) => state.phase);
  const info = useUpdater((state) => state.info);
  const progress = useUpdater((state) => state.progress);
  const download = useUpdater((state) => state.download);
  const install = useUpdater((state) => state.install);

  // Sonde au montage : l'utilisateur ne doit pas avoir à deviner qu'un correctif existe, surtout
  // quand l'écran affiché est déjà un écran de panne. Différée et muette (cf. le store), et une
  // seule fois par session quel que soit le nombre de montages.
  useEffect(() => { scheduleUpdateBootstrapCheck(); }, []);

  const busy = phase === "downloading" || phase === "installing";
  const ready = phase === "downloaded";

  // Rien à proposer : ni bouton, ni place occupée. Les états de travail restent affichés, sinon
  // l'action disparaîtrait sous le doigt de celui qui vient de cliquer.
  if (!updaterAvailable() || (phase !== "available" && !busy && !ready)) return null;

  // Pourcentage à la décimale : sur une centaine de mégaoctets, un entier arrondi reste figé
  // plusieurs secondes puis saute — la décimale prouve que le téléchargement avance vraiment.
  const percent = progress == null
    ? null
    : new Intl.NumberFormat(i18n.language, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 })
        .format(Math.min(100, progress) / 100);

  const action = t("setup:update.action");
  const label = ready ? action : phase === "installing" ? t("settings:updates.installing") : phase === "downloading" ? (percent ?? t("settings:updates.downloading")) : action;
  // Survol : d'abord ce que le clic va faire (« Mettre à jour »), la version ensuite. L'inverse
  // demandait de traduire « Version 0.3.6 disponible » en une action avant d'oser cliquer.
  const tip = ready
    ? `${action} · ${t("settings:updates.downloaded")}`
    : phase === "installing"
      ? t("settings:updates.installing")
      : phase === "downloading"
        ? `${t("settings:updates.downloading")} ${percent ?? ""}`.trim()
        : info?.version ? `${action} · v${info.version}` : action;
  const onClick = ready ? () => void install() : phase === "available" ? () => void download() : undefined;

  if (variant === "icon") {
    // Anneau de progression : un `conic-gradient` sur un disque de 14 px, zéro dépendance et zéro
    // animation JS — la barre de titre ne doit rien coûter pendant que la vidéo décode à côté.
    const ring = phase === "downloading" && progress != null
      ? { background: `conic-gradient(var(--color-primary) ${Math.min(100, progress)}%, var(--color-muted) 0)` }
      : undefined;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={tip}
              disabled={busy}
              onClick={onClick}
              className={`inline-flex h-9 items-center justify-center gap-1.5 px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-100 [&_svg]:size-3.5 ${
                ready ? "bg-primary text-primary-foreground hover:bg-primary/80" : "text-primary hover:bg-muted"
              } ${className ?? ""}`}
            >
              {phase === "downloading" && ring ? (
                <span className="grid size-3.5 place-items-center rounded-full" style={ring}>
                  <span className="size-2 rounded-full bg-card" />
                </span>
              ) : phase === "installing" ? (
                <Loader2 className="animate-spin" />
              ) : ready ? (
                <RefreshCw />
              ) : (
                <Download />
              )}
              {(ready || busy) && <span className="tabular-nums">{label}</span>}
            </button>
          }
        />
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button size="sm" className={className} disabled={busy} onClick={onClick} />}
      >
        {phase === "installing" ? <Loader2 className="size-3.5 animate-spin" /> : ready ? <RefreshCw className="size-3.5" /> : <Download className="size-3.5" />}
        <span className="tabular-nums">{phase === "downloading" ? (percent ?? t("settings:updates.downloading")) : ready ? action : t("setup:update.download")}</span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
