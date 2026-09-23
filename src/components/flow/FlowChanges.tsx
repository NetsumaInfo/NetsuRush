// Ce que l'agent a fait à la composition, à côté de l'image.
//
// La proposition vivait dans le fil de discussion, dans le panneau étroit de
// gauche : elle défilait avec les messages, et une réécriture de source s'y
// annonçait par un compte de caractères. Autrement dit, l'agent répondait et
// rien ne montrait la modification.
//
// Ici, une colonne à droite de l'aperçu : ce qui est PROPOSÉ en haut, avec le
// vrai diff et les deux boutons, puis l'historique de ce qui a été APPLIQUÉ. La
// séparation est la même que dans les outils : rien n'a bougé tant qu'on n'a pas
// cliqué, et une fois cliqué, la trace reste.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, History, Sparkles, Undo2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn, uiLocale } from "@/lib/utils";
import { sourceDiff } from "@/lib/flowDiff";
import type { FlowState } from "@/lib/bridge";
import type { FlowOperation, FlowProposal } from "@/components/flow/useFlowAgent";

/// Un jeu de modifications déjà appliqué. La source d'avant est gardée avec lui :
/// sans elle, le diff d'une réécriture ne se recalcule plus une fois la
/// composition remplacée.
export type AppliedChange = {
  id: string;
  at: number;
  summary: string;
  operations: FlowOperation[];
  /// La source d'AVANT. C'est elle qui rend le retour en arriere possible : une
  /// fois la composition remplacee, plus rien ne permettrait de la reconstruire.
  previousHtml: string;
  /// Deja annulee. On garde la ligne plutot que de l'effacer : l'historique
  /// raconte ce qui s'est passe, y compris ce qu'on a defait.
  reverted?: boolean;
};

/** Valeur affichable d'une variable, dans la forme que la composition a déclarée. */
const shown = (value: unknown) => (value === undefined || value === null ? "—" : String(value));

/** Le diff d'une réécriture de source, replié par défaut : c'est un document. */
function SourceDiff({ before, after }: { before: string; after: string }) {
  const { t } = useTranslation("flow");
  const [open, setOpen] = useState(true);
  const diff = useMemo(() => sourceDiff(before, after), [before, after]);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group flex items-center gap-1.5 rounded-sm text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn("size-3 transition-transform duration-200", open ? "rotate-0" : "-rotate-90")}
        />
        <span className="font-medium text-foreground">{t("opSource")}</span>
        <span className="font-mono text-[11px] tabular-nums text-[var(--color-ok)]">+{diff.added}</span>
        <span className="font-mono text-[11px] tabular-nums text-destructive">−{diff.removed}</span>
      </button>

      {open ? (
        diff.tooLarge ? (
          <p className="text-[11px] text-muted-foreground">{t("diffTooLarge")}</p>
        ) : (
          <pre className="max-h-72 overflow-auto rounded-md border border-border/70 bg-card font-mono text-[11px] leading-relaxed">
            {diff.lines.map((line, index) => {
              if (line.kind === "gap") {
                return (
                  <div key={index} className="select-none bg-muted/30 px-2 py-0.5 text-center text-[10px] text-muted-foreground">
                    {t("diffHidden", { count: Number(line.text) })}
                  </div>
                );
              }
              return (
                <div
                  key={index}
                  className={cn(
                    "flex gap-2 whitespace-pre-wrap break-all px-2",
                    line.kind === "add" && "bg-[var(--color-ok)]/10 text-[var(--color-ok)]",
                    line.kind === "del" && "bg-destructive/10 text-destructive",
                  )}
                >
                  <span className="w-8 shrink-0 select-none text-right tabular-nums text-muted-foreground/60">
                    {line.after ?? line.before}
                  </span>
                  <span className="w-2 shrink-0 select-none text-muted-foreground/70">
                    {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                  </span>
                  <span className="min-w-0 flex-1">{line.text || " "}</span>
                </div>
              );
            })}
          </pre>
        )
      ) : null}
    </div>
  );
}

/// Une opération, dans les termes de l'Inspector plutôt que dans ceux du modèle.
function OperationRow({ operation, state, previousHtml }: {
  operation: FlowOperation;
  state: FlowState;
  previousHtml: string;
}) {
  const { t } = useTranslation("flow");

  if (operation.type === "variable.set") {
    const declared = state.variables.find((v) => v.id === operation.variableId);
    return (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {declared?.label || operation.variableId}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground line-through">
            {shown(operation.previous)}
          </span>
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">→</span>
          <span className="shrink-0 font-mono text-[11px] font-medium">{shown(operation.value)}</span>
        </div>
        {operation.reason ? (
          <p className="text-[11px] text-muted-foreground">{operation.reason}</p>
        ) : null}
      </div>
    );
  }

  if (operation.type === "format.set") {
    return (
      <div className="flex items-baseline gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{t("format")}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground line-through">
          {state.width} × {state.height}
        </span>
        <span aria-hidden="true" className="shrink-0 text-muted-foreground">→</span>
        <span className="shrink-0 font-mono text-[11px] font-medium tabular-nums">
          {operation.width} × {operation.height}
        </span>
      </div>
    );
  }

  return <SourceDiff before={previousHtml} after={operation.source} />;
}

/** Un jeu de modifications : son résumé, ses opérations, et rien d'autre. */
function ChangeSet({ summary, operations, state, previousHtml }: {
  summary: string;
  operations: FlowOperation[];
  state: FlowState;
  previousHtml: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      {summary ? <p className="text-xs leading-relaxed">{summary}</p> : null}
      <div className="flex flex-col gap-1.5">
        {operations.map((operation, index) => (
          <OperationRow
            key={index}
            operation={operation}
            state={state}
            previousHtml={previousHtml}
          />
        ))}
      </div>
    </div>
  );
}

/** Heure courte, sans dépendance : l'historique se lit dans la session en cours. */
const clock = (at: number) =>
  new Date(at).toLocaleTimeString(uiLocale(), { hour: "2-digit", minute: "2-digit" });

/// Les modifications, DANS le fil de l'IA.
///
/// Elles occupaient une colonne de 360 px a droite de l'apercu. C'est la
/// conversation qui les produit : les lire ailleurs obligeait a regarder deux
/// endroits pour suivre une seule chose, et coutait a l'apercu la largeur dont
/// il a le plus besoin. Ici, pas de cadre a soi — la section suit le fil.
export function FlowChanges({ state, proposal, applied, applying, onApply, onReject, onRevert }: {
  state: FlowState;
  proposal: FlowProposal | null;
  applied: AppliedChange[];
  applying: boolean;
  onApply: () => void;
  onReject: () => void;
  /// Remet la composition dans l'etat qui precedait cette modification.
  onRevert: (change: AppliedChange) => void;
}) {
  const { t } = useTranslation("flow");
  const [openId, setOpenId] = useState<string | null>(null);

  if (!proposal && !applied.length) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 text-primary" />
        <span className="text-xs font-medium">{t("changes")}</span>
        {applied.length ? (
          <Badge variant="secondary" className="text-[10px]">{applied.length}</Badge>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        {proposal ? (
          <div className="flex flex-col gap-3 rounded-md border border-primary/40 bg-primary/5 p-3 animate-in fade-in-0 slide-in-from-bottom-2 duration-200">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">{t("proposal")}</span>
              <Badge variant="secondary" className="text-[10px]">{proposal.operations.length}</Badge>
            </div>
            <ChangeSet
              summary={proposal.summary}
              operations={proposal.operations}
              state={state}
              previousHtml={state.html || ""}
            />
            <div className="flex gap-2">
              <Button size="sm" className="h-7" onClick={onApply} disabled={applying}>
                {applying ? <Spinner className="size-3.5" /> : <Check className="size-3.5" />}
                {t("apply")}
              </Button>
              <Button size="sm" variant="ghost" className="h-7" onClick={onReject} disabled={applying}>
                <X className="size-3.5" />
                {t("reject")}
              </Button>
            </div>
          </div>
        ) : null}

        {applied.map((change) => {
          const open = openId === change.id;
          return (
            <div key={change.id} className={cn("flex flex-col rounded-md border", change.reverted && "opacity-60")}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpenId(open ? null : change.id)}
                className="group flex items-center gap-2 px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <History className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{change.summary || t("applied")}</span>
                {change.reverted ? (
                  <Badge variant="outline" className="shrink-0 text-[10px]">{t("reverted")}</Badge>
                ) : null}
                <span className="shrink-0 tabular-nums text-muted-foreground/70">{clock(change.at)}</span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn("size-3 shrink-0 opacity-40 transition-transform duration-200", open ? "rotate-180" : "")}
                />
              </button>
              <div className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-out",
                open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
                <div className="min-h-0 overflow-hidden">
                  <div className="flex flex-col gap-2 border-t px-2.5 py-2">
                    <ChangeSet
                      summary=""
                      operations={change.operations}
                      state={state}
                      previousHtml={change.previousHtml}
                    />
                    {/* Reappliquer la source d'avant. Ce retour est lui-meme une
                        modification : il entre dans l'historique plutot que
                        d'effacer la ligne, sinon on ne saurait plus ce qui a
                        ete tente. */}
                    <div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-xs"
                        disabled={applying || change.reverted}
                        onClick={() => onRevert(change)}
                      >
                        <Undo2 className="size-3" />
                        {t("revert")}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}

      </div>
    </div>
  );
}
