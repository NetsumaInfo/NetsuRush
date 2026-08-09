import { X, AlertTriangle, Check, CircleAlert } from "lucide-react";
import { useApp } from "@/store";
import { Spinner } from "@/components/ui/spinner";
import { Progress } from "@/components/ui/progress";

// Retour visuel de l'envoi vers la timeline (bouton « Timeline » des cartes) :
// - pendant l'envoi : barre de progression (cache instantané ou détection IA) ;
// - après : toast de résultat (succès / avertissement fps / erreur), refermable.
// (Le glisser d'un rush vers DaVinci est un drag OS natif géré côté carte — pas ici.)
export function TimelineDrop() {
  const tlBusy = useApp((s) => s.tlBusy);
  const tlNotice = useApp((s) => s.tlNotice);
  const dismiss = useApp((s) => s.dismissTlNotice);

  return (
    <>
      {tlBusy && (
        <div className="fixed inset-x-4 bottom-4 z-50 overflow-hidden rounded-2xl border border-border bg-card px-4 py-3 shadow-2xl shadow-black/40">
          <div className="flex items-center gap-2 text-sm">
            <Spinner /> {tlBusy.phase}
            {tlBusy.pct > 0 && tlBusy.pct < 100 && <span className="tabular-nums text-muted-foreground">{tlBusy.pct}%</span>}
          </div>
          <Progress value={tlBusy.pct} className="mt-2 [&_[data-slot=progress-track]]:h-0.5" />
        </div>
      )}

      {tlNotice && !tlBusy && (
        <div className={`fixed inset-x-4 bottom-4 z-50 flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-sm shadow-2xl shadow-black/40 ${
          tlNotice.kind === "ok" ? "border-[var(--color-ok)]/40 bg-card text-foreground"
            : tlNotice.kind === "warn" ? "border-[var(--color-warn)]/50 bg-card text-foreground"
            : "border-destructive/50 bg-card text-foreground"}`}>
          {tlNotice.kind === "ok" ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-ok)]" />
            : tlNotice.kind === "warn" ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warn)]" />
            : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
          <span className="min-w-0 flex-1">{tlNotice.text}</span>
          <button type="button" aria-label="Fermer la notification" onClick={dismiss} className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </>
  );
}
