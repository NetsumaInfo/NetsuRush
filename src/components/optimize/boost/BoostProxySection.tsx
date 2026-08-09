// Proxies attachés — le gain de lecture le plus fort côté Premiere, et NetsuRush sait déjà encoder.
// After Effects n'a pas d'équivalent (pas de proxy attaché au sens Premiere) : la section n'est rendue
// que pour Premiere.
//
// Enchaînement : audit du projet → sélection → un encodage PAR rush (profil d'export actif) →
// `attachProxy` par lots côté core. Un encodage par appel, jamais un lot : `exportClips` rend une
// liste de fichiers dont l'ordre n'est pas contractuel, or il faut apparier proxy ↔ source sans
// ambiguïté. Le portail d'encodage global (core/export/gate.js) borne déjà les ffmpeg simultanés.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Loader2, Layers, CheckSquare, Square } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { nr } from "@/lib/bridge";
import type { AdobeApp, BoostDiagnosis, BoostProxyItem } from "@/lib/bridge";
import { useApp } from "@/store";
import { getActiveExportProfile } from "@/features/export/profiles";

export function BoostProxySection({ diag, app }: { diag: BoostDiagnosis | null; app: AdobeApp }) {
  const { t } = useTranslation("optimize");
  const profiles = useApp((s) => s.exportProfiles);
  const activeId = useApp((s) => s.activeExportProfileId);
  const [items, setItems] = useState<BoostProxyItem[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const ready = !!diag?.panelConnected;

  const audit = useCallback(async () => {
    if (!ready) {
      setItems([]);
      return;
    }
    setLoading(true);
    setNotice(null);
    try {
      const r = await nr.boostProxyAudit(app);
      setItems(r.items || []);
      setEnabled(!!r.enableProxies);
      if (!r.ok) {
        setFailed(true);
        setNotice(r.error || t("notice.failed"));
      }
      // Pré-sélection de ce qui manque : c'est exactement le travail que la section propose de faire.
      setSel(new Set((r.items || []).filter((i) => i.canProxy && !i.hasProxy).map((i) => i.path)));
    } catch (e) {
      setFailed(true);
      setNotice(String(e));
    } finally {
      setLoading(false);
    }
  }, [app, ready, t]);

  useEffect(() => {
    void audit();
  }, [audit]);

  async function toggleGlobal(on: boolean) {
    setEnabled(on);
    const r = await nr.boostSetEnableProxies(app, on);
    if (!r.ok) {
      setEnabled(!on);
      setFailed(true);
      setNotice(r.error || t("notice.failed"));
    }
  }

  const toggle = (p: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const targets = items.filter((i) => sel.has(i.path) && i.canProxy);

  async function generate() {
    const profile = getActiveExportProfile(profiles, activeId);
    const dir = await nr.chooseDir();
    if (!dir || !profile) return;
    setRunning(true);
    setDone(0);
    setFailed(false);
    const pairs: { path: string; proxy: string }[] = [];
    const encodeFailed: string[] = [];
    for (const item of targets) {
      try {
        const info = await nr.probe(item.path);
        const res = await nr.exportClips({
          clips: [{ input: item.path, start: 0, end: info.duration, label: item.name }],
          dir,
          // Chaque rush de la file sort dans le MÊME dossier : sans nom de base, tous retombaient sur
          // le nom générique du profil et s'écrasaient l'un l'autre (un seul proxy pour toute la file,
          // et `pairs` les faisait tous pointer dessus).
          baseName: item.name.replace(/\.[^.]+$/, ""),
          profile,
          jobId: `boost-proxy:${item.path}`,
        });
        const out = res.files && res.files[0];
        if (res.ok && out) pairs.push({ path: item.path, proxy: out });
        else encodeFailed.push(item.path);
      } catch {
        // Un rush illisible ne doit pas emporter la file : on le note et on continue.
        encodeFailed.push(item.path);
      }
      setDone((n) => n + 1);
    }

    if (!pairs.length) {
      setRunning(false);
      setFailed(true);
      setNotice(t("boost.proxy.encodeFailed", { count: encodeFailed.length }));
      return;
    }
    const attach = await nr.boostAttachProxies(app, pairs);
    setRunning(false);
    // « 180 sur 200 » est un succès partiel, pas un échec : les deux nombres sont dits.
    const missed = encodeFailed.length + (attach.failed?.length || 0);
    setFailed(!attach.ok);
    setNotice(
      attach.ok
        ? missed
          ? t("boost.proxy.attachedPartial", { count: attach.attached, missed })
          : t("boost.proxy.attached", { count: attach.attached })
        : attach.error || t("notice.failed"),
    );
    await audit();
  }

  if (app !== "ppro") return null;

  const withProxy = items.filter((i) => i.hasProxy).length;

  return (
    <Card className="block p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{t("boost.proxy.title")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {ready ? t("boost.proxy.summary", { withProxy, total: items.length }) : t("boost.proxy.needsPanel")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Toggle pressed={enabled} onPressedChange={toggleGlobal} size="sm" disabled={!ready || running}>
            {t("boost.proxy.useProxies")}
          </Toggle>
          <Button variant="ghost" size="sm" onClick={audit} disabled={!ready || loading || running}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("boost.proxy.rescan")}
          </Button>
        </div>
      </div>

      {items.length > 0 && (
        <ul className="mt-3 max-h-72 divide-y divide-border overflow-auto rounded-md border border-border">
          {items.map((i) => {
            const on = sel.has(i.path);
            return (
              <li key={i.path}>
                <button
                  type="button"
                  onClick={() => i.canProxy && toggle(i.path)}
                  disabled={!i.canProxy}
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs hover:bg-muted/50 disabled:opacity-50"
                >
                  {on ? (
                    <CheckSquare className="h-3.5 w-3.5 shrink-0 text-primary" />
                  ) : (
                    <Square className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <Tooltip>
                    <TooltipTrigger render={<span className="min-w-0 flex-1 truncate">{i.name}</span>} />
                    <TooltipContent>{i.path}</TooltipContent>
                  </Tooltip>
                  {i.hasProxy ? (
                    <Badge className="bg-[var(--color-ok)]/15 text-[var(--color-ok)]">{t("boost.proxy.has")}</Badge>
                  ) : i.canProxy ? (
                    <Badge variant="secondary">{t("boost.proxy.missing")}</Badge>
                  ) : (
                    <Badge variant="secondary">{t("boost.proxy.cannot")}</Badge>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {running && (
        <div className="mt-3">
          <div className="mb-1 text-xs text-muted-foreground">
            {t("boost.proxy.encoding", { done, total: targets.length })}
          </div>
          <Progress value={targets.length ? Math.round((done / targets.length) * 100) : 0} />
        </div>
      )}

      <Button size="sm" className="mt-3" disabled={!ready || !targets.length || running} onClick={generate}>
        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />}
        {t("boost.proxy.generate", { count: targets.length })}
      </Button>

      {notice && <p className={`mt-3 text-xs ${failed ? "text-destructive" : "text-[var(--color-ok)]"}`}>{notice}</p>}
    </Card>
  );
}
