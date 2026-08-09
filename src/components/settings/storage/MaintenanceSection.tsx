// Entretien de la base. La taille physique de netsurush.db ne veut rien dire seule — c'est à côté du
// bouton « Compacter » qu'elle devient une décision : un fichier de 500 Mo pour 200 Mo de contenu
// signifie qu'une purge a laissé de l'espace non rendu au disque.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Database, FileQuestion, Minimize2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApp } from "@/store";
import { fmtBytes } from "./storageShared";

function DbBlock() {
  const { t } = useTranslation("settings");
  const { db, faiss, busy, vacuum } = useApp(
    useShallow((s) => ({ db: s.cacheOverview?.db, faiss: s.cacheOverview?.faiss, busy: s.cacheBusy, vacuum: s.vacuumCache })),
  );
  const [msg, setMsg] = useState<string | null>(null);
  if (!db) return null;

  async function run() {
    const r = await vacuum();
    setMsg(r.ok ? t("storage.db.vacuumDone", { size: fmtBytes(r.freed) }) : t("storage.db.vacuumBusy"));
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-3">
        <Database className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-foreground">{t("storage.db.title")}</p>
          <Tooltip>
            <TooltipTrigger render={<p className="truncate text-[11px] tabular-nums text-muted-foreground" />}>
              {db.available ? fmtBytes(db.bytes) : t("storage.db.unavailable")}
              {faiss && faiss.bytes > 0 ? ` · ${t("storage.db.faiss", { size: fmtBytes(faiss.bytes) })}` : ""}
            </TooltipTrigger>
            <TooltipContent className="max-w-96 break-all">{db.path}</TooltipContent>
          </Tooltip>
        </div>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="sm" onClick={() => void run()} disabled={!db.available || !!busy} />}>
            <Minimize2 className="size-3.5" /> {t("storage.db.vacuum")}
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{t("storage.db.vacuumHint")}</TooltipContent>
        </Tooltip>
      </div>
      {msg && <p className="mt-2 text-[11px] text-muted-foreground">{msg}</p>}
    </div>
  );
}

function MissingBlock() {
  const { t } = useTranslation("settings");
  const { missing, load, clear, busy } = useApp(
    useShallow((s) => ({ missing: s.cacheMissing, load: s.loadCacheMissing, clear: s.clearCache, busy: s.cacheBusy })),
  );
  const [confirm, setConfirm] = useState(false);

  useEffect(() => { void load(); }, [load]);
  if (!missing) return null;

  const total = missing.reduce((n, m) => n + m.bytes, 0);

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-3">
        <FileQuestion className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-foreground">{t("storage.missing.title")}</p>
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {missing.length ? `${missing.length} · ${fmtBytes(total)}` : t("storage.missing.none")}
          </p>
        </div>
        {missing.length > 0 && (
          <Button
            variant={confirm ? "destructive" : "outline"}
            size="sm"
            disabled={!!busy}
            onClick={() => {
              // Confirmation EN PLACE plutôt qu'une modale : l'action est réversible (le cache se
              // régénère) et une modale pour deux clics serait de la lourdeur gratuite.
              if (!confirm) return setConfirm(true);
              void clear({ sources: missing.map((m) => m.source) }).then(() => { setConfirm(false); void load(); });
            }}
            onBlur={() => setConfirm(false)}
          >
            <Trash2 className="size-3.5" /> {confirm ? t("storage.confirm.confirm") : t("storage.missing.purge")}
          </Button>
        )}
      </div>
      {/* Le « pourquoi » n'apparaît que s'il y a quelque chose à décider. */}
      {missing.length > 0 && <p className="mt-2 text-[11px] text-muted-foreground">{t("storage.missing.desc")}</p>}
    </div>
  );
}

export function MaintenanceSection() {
  const { t } = useTranslation("settings");
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t("storage.maintenance.title")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("storage.maintenance.desc")}</p>
      </div>
      <DbBlock />
      <MissingBlock />
    </section>
  );
}
