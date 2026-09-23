// Ce que l'agent a fait pendant le tour, dans l'ordre : une trace repliable au-dessus de sa réponse.
//
// Ce qu'il y avait avant disait la même chose en trois morceaux qui ne se parlaient pas — un bouton
// « Raisonnement », une pile de lignes d'outils, un indicateur « Réflexion… » — et surtout dans le
// DÉSORDRE : tout le raisonnement d'un côté, tous les outils de l'autre, alors qu'un agent alterne.
// Ici une seule colonne chronologique, sous un en-tête qui dit l'état du tour et ce qu'il a coûté en
// temps. Repliée dès que le tour est fini : la réponse est ce qu'on vient lire, la trace est là pour
// quand on doute d'elle.
//
// Deux détails qui font le rendu :
//   — l'icône de chaque ligne se change en chevron au SURVOL, donc rien n'annonce « repliable » tant
//     qu'on ne s'en approche pas, et la colonne reste calme ;
//   — la hauteur s'anime par `grid-template-rows: 0fr → 1fr`, la seule façon d'animer vers une
//     hauteur inconnue sans la mesurer en JS.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AlertCircle, Brain, Check, CheckCheck, ChevronDown, Copy, Braces, Dot, ChevronsUpDown, Terminal } from "lucide-react";
import type { UiMessage, UiStep, UiToolCall } from "@/store/chat";
import { useApp } from "@/store";
import { cn, fmtMillis, fmtSeconds } from "@/lib/utils";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { toolLabel } from "./toolLabel";

/** Copie d'une valeur d'appel : chaîne telle quelle, sinon JSON indenté. */
const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

/** Aperçu borné : un résultat d'outil peut faire des milliers de lignes. */
const short = (value: unknown) => {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text && text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch { return String(value); }
};

/**
 * La pastille à droite du libellé : l'argument qui dit « sur QUOI ». Le libellé donne le verbe, il
 * lui manquait toujours l'objet — « Lire la timeline » sans dire laquelle.
 */
function chipOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "file", "name", "text", "query", "action", "root"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/**
 * La commande shell d'un appel, s'il en est un.
 *
 * Avec un agent en ligne de commande, ce sont SES outils qui remontent — `Bash`, `Edit`, `Read` —
 * et pas les nôtres (cf. `core/agent/runtimes/parsers.js`). Une commande shell rendue comme un
 * `{"command": "…"}` en JSON était illisible là où elle a une forme que tout le monde connaît.
 */
function shellCommand(tool: UiToolCall): string | null {
  const input = tool.input;
  if (typeof input === "string" && /^(bash|shell|sh)$/i.test(tool.name)) return input;
  if (input && typeof input === "object") {
    const command = (input as Record<string, unknown>).command;
    if (typeof command === "string" && command.trim()) return command;
  }
  return null;
}

/** Le texte d'un résultat d'outil, quand il en a un de lisible. */
function outputOf(result: unknown): string {
  if (result == null) return "";
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

/** Bouton « copier » qui dit qu'il a copié, puis se tait. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      className="shrink-0 rounded-sm px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {copied ? <CheckCheck className="size-3 text-[var(--color-ok)]" /> : <Copy className="size-3" />}
    </button>
  );
}

/**
 * Une commande et ce qu'elle a écrit, dans sa forme habituelle.
 *
 * Les lignes de sortie sont teintées sur ce qu'elles CONTIENNENT (« passed », « FAIL », « warning »)
 * : c'est une heuristique, pas une analyse — elle ne sert qu'à faire ressortir l'échec dans un mur
 * de texte, jamais à décider si la commande a réussi. Ça, c'est le badge, et il vient du résultat.
 */
function TerminalBlock({ command, output, done, ok, t }: {
  command: string; output: string; done: boolean; ok?: boolean; t: TFunction<"chat">;
}) {
  return (
    <div className="flex w-full flex-col overflow-hidden rounded-md border border-border/80 bg-card font-mono text-[11px]">
      <div className="flex items-center gap-2 border-b border-border/70 bg-muted/40 px-2 py-1">
        <Terminal className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span className="select-none font-bold text-muted-foreground/60">$</span>
        <span className="min-w-0 flex-1 truncate font-semibold text-foreground">{command}</span>
        {done && (
          <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
            ok === false ? "bg-destructive/10 text-destructive" : "bg-[var(--color-ok)]/10 text-[var(--color-ok)]")}>
            {t(ok === false ? "toolcard.failed" : "toolcard.done")}
          </span>
        )}
        <CopyButton text={output ? `$ ${command}\n\n${output}` : `$ ${command}`} label={t("toolcard.copyResult")} />
      </div>
      {output && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all bg-muted/20 p-2 text-[11px] leading-relaxed">
          {output.split("\n").map((line, index) => (
            <div key={index} className={cn(
              /(\bpassed\b|\bPASS\b|✓)/.test(line) && "text-[var(--color-ok)]",
              /(\bFAIL\b|\bError\b|\bfailed\b)/.test(line) && "text-destructive",
              /(\bWARN\b|\bwarning\b)/i.test(line) && "text-[var(--color-warn)]",
            )}>{line}</div>
          ))}
        </pre>
      )}
    </div>
  );
}

/** Durée lisible : sous la seconde on parle en millisecondes, au-delà en secondes à une décimale. */
function humanDuration(ms: number): string {
  return ms < 1000 ? fmtMillis(ms) : fmtSeconds(ms / 1000, { fixed: true });
}

/** Grille 3×3 qui pulse pendant le tour — un « ça travaille », pas un « ça charge ». */
function PixelDots() {
  return (
    <span aria-hidden="true" className="grid shrink-0 grid-cols-[repeat(3,3px)] items-center gap-[1.5px]">
      {Array.from({ length: 9 }, (_, index) => {
        const delay = ((index % 3) + Math.abs(Math.floor(index / 3) - 1)) * 90;
        return <span key={index} className="nr-pixel-dot size-[3px] rounded-full bg-foreground/80"
          style={{ opacity: 0.2, animation: `nr-pixel 650ms cubic-bezier(0.23,1,0.32,1) ${delay}ms infinite` }} />;
      })}
    </span>
  );
}

/** Libellé balayé tant que le tour tourne. Dégradé clippé au texte : la couleur DOIT être transparente. */
function Shimmer({ children }: { children: React.ReactNode }) {
  return (
    <span className="nr-shimmer bg-clip-text font-medium text-transparent"
      style={{
        backgroundImage: "linear-gradient(90deg, var(--color-muted-foreground) 35%, var(--color-foreground) 50%, var(--color-muted-foreground) 65%)",
        backgroundSize: "200% 100%",
        animation: "nr-shimmer 1.6s linear infinite",
      }}>
      {children}
    </span>
  );
}

/** Enveloppe repliable commune aux lignes : hauteur animée sans mesure JS. */
function Collapsible({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-out",
      open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
      <div className="min-h-0 overflow-hidden">
        <div className="mb-1 ml-2.5 border-l border-border/70 py-0.5 pl-2.5">{children}</div>
      </div>
    </div>
  );
}

/** L'icône d'état, qui cède la place au chevron au survol quand la ligne s'ouvre. */
function RowIcon({ open, expandable, children }: { open: boolean; expandable: boolean; children: React.ReactNode }) {
  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground">
      <span className={cn("flex items-center justify-center transition-opacity duration-150",
        expandable && "group-hover/row:opacity-0", open && "opacity-0")}>
        {children}
      </span>
      {expandable && (
        <ChevronDown aria-hidden="true"
          className={cn("absolute size-3.5 opacity-0 transition-transform duration-200 group-hover/row:opacity-100",
            open ? "rotate-0 opacity-100" : "-rotate-90")} />
      )}
    </span>
  );
}

const ROW = "group/row flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-xs transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function ReasoningRow({ text, active }: { text: string; active: boolean }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className={ROW}>
        <RowIcon open={open} expandable><Brain className="size-3.5 opacity-75" /></RowIcon>
        {active
          ? <Shimmer>{t("message.thinking")}</Shimmer>
          : <span className="font-medium text-foreground">{t("message.reasoning")}</span>}
      </button>
      <Collapsible open={open}>
        <p className="max-h-56 select-text overflow-y-auto whitespace-pre-wrap pr-1 text-[11.5px] leading-relaxed text-muted-foreground">
          {text}
        </p>
      </Collapsible>
    </div>
  );
}

function ToolRow({ tool, t }: { tool: UiToolCall; t: TFunction<"chat"> }) {
  const [open, setOpen] = useState(false);
  const label = toolLabel(tool.name, tool.input, t);
  const command = shellCommand(tool);
  const chip = chipOf(tool.input);
  const failed = tool.done && tool.ok === false;
  const duration = tool.endedAt && tool.startedAt ? tool.endedAt - tool.startedAt : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="flex flex-col" />}>
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className={ROW}>
          <RowIcon open={open} expandable>
            {!tool.done
              ? <span aria-hidden="true" className="size-3.5 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-foreground" />
              : failed
                ? <AlertCircle className="size-3.5 text-destructive" />
                : command
                  ? <Terminal className="size-3.5 text-primary" />
                  : <Check className="size-3.5 text-[var(--color-ok)]" />}
          </RowIcon>
          <span className={cn("shrink-0 font-medium tracking-tight", failed ? "text-destructive" : "text-foreground")}>{label}</span>
          {chip && (
            <span className="inline-flex h-5 min-w-0 max-w-[60%] items-center truncate rounded-md border border-border/40 bg-muted/80 px-1.5 font-mono text-[11px] text-muted-foreground transition-colors group-hover/row:border-border group-hover/row:text-foreground">
              <span className="truncate">{chip}</span>
            </span>
          )}
          {duration !== null && (
            <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70">{humanDuration(duration)}</span>
          )}
        </button>
        <Collapsible open={open}>
          {command ? (
            <TerminalBlock command={command} output={outputOf(tool.result)} done={tool.done} ok={tool.ok} t={t} />
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground"><Dot className="size-3" />{tool.name}</div>
              <div>
                <div className="mb-0.5 text-[10px] text-muted-foreground">{t("toolcard.arguments")}</div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/80">{short(tool.input)}</pre>
              </div>
              {tool.done && (
                <div>
                  <div className="mb-0.5 text-[10px] text-muted-foreground">{t("toolcard.result")}</div>
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/80">{short(tool.result)}</pre>
                </div>
              )}
            </div>
          )}
        </Collapsible>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(tool.name)}><Dot /> {t("toolcard.copyName")}</ContextMenuItem>
        {tool.input != null && (
          <ContextMenuItem onClick={() => navigator.clipboard.writeText(asText(tool.input))}><Braces /> {t("toolcard.copyArgs")}</ContextMenuItem>
        )}
        {tool.done && tool.result != null && (
          <ContextMenuItem onClick={() => navigator.clipboard.writeText(asText(tool.result))}><Copy /> {t("toolcard.copyResult")}</ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => setOpen((value) => !value)}>
          <ChevronsUpDown /> {open ? t("toolcard.collapse") : t("toolcard.expand")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Une conversation rechargée depuis l'historique n'a plus de chronologie — elle n'a jamais été
 * enregistrée. Plutôt que d'afficher une trace vide, on en reconstitue une plausible : la pensée
 * d'abord, les outils ensuite. C'est faux sur l'ordre, jamais sur le contenu.
 */
function stepsOf(msg: UiMessage): UiStep[] {
  if (msg.steps.length) return msg.steps;
  const steps: UiStep[] = [];
  if (msg.thinking) steps.push({ kind: "reasoning", text: msg.thinking });
  for (const tool of msg.tools) steps.push({ kind: "tool", id: tool.id });
  return steps;
}

/** Horloge qui n'existe QUE pendant le tour : un `setInterval` permanent réveillerait le fil pour rien. */
function useElapsed(msg: UiMessage, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);
  if (!msg.startedAt) return 0;
  return Math.max(0, Math.round(((msg.endedAt ?? (running ? now : msg.startedAt)) - msg.startedAt) / 1000));
}

/// `status` : le libellé « ce qu'il fait en ce moment ». Il vient du store pour
/// NetsuPilot, et d'ailleurs pour toute fenêtre qui tient son propre tour — le
/// panneau NetsuFlow en a un, et lire celui de Pilot lui affichait le statut
/// d'une conversation qui n'est pas la sienne.
export function AgentTrace({ msg, active, status }: {
  msg: UiMessage; active: boolean; status?: string;
}) {
  const { t } = useTranslation("chat");
  const pilotStatus = useApp((s) => s.chatStatus);
  const label = status ?? pilotStatus;
  const steps = useMemo(() => stepsOf(msg), [msg]);
  const tools = useMemo(() => new Map(msg.tools.map((tool) => [tool.id, tool])), [msg.tools]);
  const running = active && !msg.endedAt;
  const seconds = useElapsed(msg, running);

  // Ouverte d'office pendant le tour, refermée quand il finit — sauf si l'utilisateur a tranché
  // lui-même, auquel cas son choix tient jusqu'à la fin du message.
  const [manual, setManual] = useState<boolean | null>(null);
  const wasRunning = useRef(running);
  useEffect(() => { if (wasRunning.current && !running) setManual((value) => value); wasRunning.current = running; }, [running]);
  const open = manual ?? running;

  if (!steps.length && !running) return null;

  return (
    <div className="flex w-full flex-col">
      <button type="button" aria-expanded={open} onClick={() => setManual(!open)}
        className="group flex w-fit items-center gap-1.5 rounded-sm text-left text-[13px] text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {running && <PixelDots />}
        {running
          ? <Shimmer>{label || t("trace.working")}</Shimmer>
          : <span>{t("trace.workedFor", { count: seconds })}</span>}
        <ChevronDown aria-hidden="true"
          className={cn("size-3 opacity-30 transition-transform duration-300 group-hover:opacity-80", open ? "rotate-180" : "rotate-0")} />
      </button>

      <div className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-out",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
        <div className="min-h-0 overflow-hidden">
          <div className="ml-2 mt-1 flex flex-col gap-0.5 border-l border-border/60 py-0.5 pl-2">
            {steps.map((step, index) => {
              if (step.kind === "reasoning") {
                // Le raisonnement n'est « en cours » que s'il est la DERNIÈRE étape : au-delà,
                // l'agent est passé à autre chose et la pensée est close.
                const live = running && index === steps.length - 1;
                return <ReasoningRow key={`r${index}`} text={step.text} active={live} />;
              }
              const tool = tools.get(step.id);
              return tool ? <ToolRow key={tool.id} tool={tool} t={t} /> : null;
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
