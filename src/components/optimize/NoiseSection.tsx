// Bruit d'arrière-plan : les tâches qui tournent en permanence sans servir au montage.
//
// C'est le complément de « Nettoyer les bloqués », qui ne voit que les programmes FIGÉS : un updater,
// une superposition de jeu ou un client de synchro répondent parfaitement, ils n'apparaissaient donc
// jamais. Ils sont pourtant la RAM — et pour la superposition GeForce, la session d'encodeur — qui
// manque au rendu.
//
// Rien n'est coché d'avance : la sélection est un choix de l'utilisateur, pas un défaut de l'app.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Wind, RefreshCw, Loader2, Skull } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { nr } from "@/lib/bridge";
import type { OptimizeProc } from "@/lib/bridge";
import { fmtBytes } from "./optimizeShared";

export function NoiseSection() {
  const { t } = useTranslation("optimize");
  const [procs, setProcs] = useState<OptimizeProc[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [killing, setKilling] = useState(false);
  // Un échec et une réussite ne se disent pas de la même couleur : sans ce drapeau, « analyse
  // impossible » s'afficherait en vert de succès.
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null);

  const scan = async () => {
    setScanning(true);
    setNotice(null);
    try {
      const r = await nr.optimizeNoiseProcesses();
      // « Aucune tâche inutile » n'est vrai qu'après une analyse RÉUSSIE : l'afficher après un échec
      // ferait passer une panne pour un poste propre.
      if (r.ok) {
        setProcs(r.procs);
        setScanned(true);
      } else {
        setNotice({ text: r.error || t("notice.failed"), failed: true });
      }
      setPicked(new Set());
    } catch (e) {
      setNotice({ text: String(e), failed: true });
    } finally {
      setScanning(false);
    }
  };

  const toggle = (pid: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(pid)) next.add(pid);
      return next;
    });

  const stop = async () => {
    setKilling(true);
    try {
      const r = await nr.optimizeKillNoise([...picked]);
      setNotice({ text: t("noise.stopped", { count: r.killed }), failed: false });
    } catch (e) {
      setNotice({ text: String(e), failed: true });
    } finally {
      setKilling(false);
      void scan();
    }
  };

  const freed = procs.filter((p) => picked.has(p.pid)).reduce((sum, p) => sum + p.ram, 0);

  return (
    <Card className="block p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Wind className="h-4 w-4 text-primary" /> {t("noise.title")}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("noise.subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={scan} disabled={scanning}>
          {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t("noise.scan")}
        </Button>
      </div>

      {procs.length > 0 && (
        <>
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-md border border-border">
            {procs.map((p) => (
              <li key={p.pid} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <Checkbox
                  checked={picked.has(p.pid)}
                  onCheckedChange={() => toggle(p.pid)}
                  aria-label={p.name}
                />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {p.family ? t(`noise.family.${p.family}`) : ""}
                </span>
                <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
                  {fmtBytes(p.ram)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="destructive" size="sm" onClick={stop} disabled={killing || !picked.size}>
              {killing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Skull className="h-4 w-4" />}
              {t("noise.stop", { count: picked.size })}
            </Button>
            {picked.size > 0 && (
              <span className="text-xs text-muted-foreground">{t("noise.frees", { size: fmtBytes(freed) })}</span>
            )}
          </div>
        </>
      )}

      {scanned && !procs.length && !scanning && (
        <p className="mt-3 text-xs text-muted-foreground">{t("noise.none")}</p>
      )}
      {notice && (
        <p className={`mt-3 text-xs ${notice.failed ? "text-destructive" : "text-[var(--color-ok)]"}`}>
          {notice.text}
        </p>
      )}
    </Card>
  );
}
