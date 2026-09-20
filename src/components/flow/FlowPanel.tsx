import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Play, Square, Send, Check, PanelLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { FlowAgent } from "@/components/flow/FlowAgent";
import { FlowCache } from "@/components/flow/FlowCache";
import { type AppliedChange } from "@/components/flow/FlowChanges";
import { FlowExport } from "@/components/flow/FlowExport";
import { FlowFormat } from "@/components/flow/FlowFormat";
import { FlowInspector } from "@/components/flow/FlowInspector";
import { FlowPreview } from "@/components/flow/FlowPreview";
import { useFlow } from "@/components/flow/useFlow";
import { useFlowAgent, type FlowProposal } from "@/components/flow/useFlowAgent";
import { useResizablePane } from "@/components/flow/useResizablePane";
import { useFrameSpec } from "@/components/flow/useFrameSpec";
import { useApp } from "@/store";

/// The engine is a Chromium: it starts when the user asks for it, and the tab
/// says plainly that it is not running rather than starting one on mount.
function EngineGate({ status, busy, onStart }: {
  status: { ready: boolean; prerequisite: string; error: string };
  busy: boolean;
  onStart: () => void;
}) {
  const { t } = useTranslation("flow");
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">
          {status.ready ? t("stopped") : t("notReady")}
        </p>
        {status.prerequisite ? (
          <code className="rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {status.prerequisite}
          </code>
        ) : null}
        {status.error ? <p className="text-xs text-destructive">{status.error}</p> : null}
        <Button onClick={onStart} disabled={busy || !status.ready}>
          {busy ? <Spinner className="size-4" /> : <Play className="size-4" />}
          {busy ? t("starting") : t("start")}
        </Button>
      </div>
    </div>
  );
}

function SourcePane({ value, onApply, busy }: {
  value: string;
  onApply: (html: string) => void;
  busy: boolean;
}) {
  const { t } = useTranslation("flow");
  const [draft, setDraft] = useState(value);
  const [known, setKnown] = useState(value);

  // The draft follows the service when the service changes underneath, but not
  // while the user is typing into it — that is what the `known` marker separates.
  if (value !== known) {
    setKnown(value);
    setDraft(value);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <Textarea
        className="min-h-0 flex-1 resize-none font-mono text-xs"
        spellCheck={false}
        value={draft}
        placeholder={t("sourcePlaceholder")}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button
        size="sm"
        className="self-start"
        disabled={draft === value}
        onClick={() => onApply(draft)}
      >
        {busy ? t("applying") : t("apply")}
      </Button>
    </div>
  );
}

export function FlowPanel() {
  const { t } = useTranslation("flow");
  const flow = useFlow();
  const [sent, setSent] = useState(false);
  const [note, setNote] = useState("");
  // Wide enough for the code pane, narrow enough to leave the preview usable.
  // The bound is on the pane, not on the window: a 4K screen should be able to
  // give the composition most of itself.
  const pane = useResizablePane({
    storageKey: "nr.flow.paneWidth", initial: 416, min: 280, max: 900,
  });

  // Le moteur est celui que l'utilisateur a deja choisi pour NetsuPilot : deux
  // reglages de fournisseur pour les cles d'un seul compte, ce serait une
  // seconde chose a configurer et a tenir synchrone.
  const provider = useApp((s) => s.chatProvider);
  const agentId = useApp((s) => s.chatAgentId);
  const model = useApp((s) => s.chatModel);
  const thinking = useApp((s) => s.chatThinking);
  // Le mode de permission decide si une proposition attend un clic. « Auto »
  // veut dire « ne me demande rien » : la laisser en attente d'un bouton
  // contredisait le reglage que l'utilisateur venait de choisir.
  const mode = useApp((s) => s.chatMode);
  // Le tour d'agent vit ICI et pas dans l'onglet : sa proposition s'affiche a
  // droite de l'apercu, et changer d'onglet ne doit pas jeter la conversation.
  // Le cahier de design vit ici : il alimente le prompt (via useFlowAgent) ET
  // le harnais affiche dans l'onglet IA. Un seul etat pour les deux.
  const frameSpec = useFrameSpec();
  const agent = useFlowAgent({
    provider, agent: agentId, model: model || undefined, thinking,
    frameSpec: frameSpec.spec?.text,
  });

  const [applied, setApplied] = useState<AppliedChange[]>([]);
  const [applying, setApplying] = useState(false);

  /// La derniere proposition appliquee toute seule. Sans cette trace, l'effet
  /// se redeclencherait sur le meme objet et rejouerait l'application.
  const autoApplied = useRef<FlowProposal | null>(null);

  useEffect(() => {
    const proposal = agent.proposal;
    if (!proposal || mode !== "auto" || applying) return;
    if (autoApplied.current === proposal) return;
    autoApplied.current = proposal;
    void applyProposal();
    // `applyProposal` se recree a chaque rendu ; le declencheur est la
    // proposition, pas la fonction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.proposal, mode, applying]);

  /// Remet la composition dans l'etat qui precedait une modification.
  ///
  /// La source d'avant a ete gardee au moment de l'appliquer : c'est la seule
  /// chose qui rende l'operation possible, une composition remplacee ne se
  /// reconstruit pas depuis son diff.
  const revertChange = async (change: AppliedChange) => {
    setApplying(true);
    try {
      await flow.save({ html: change.previousHtml });
      // La ligne reste, marquee : l'historique raconte ce qui s'est passe, y
      // compris ce qu'on a defait.
      setApplied((list) => list.map((c) => (c.id === change.id ? { ...c, reverted: true } : c)));
    } finally {
      setApplying(false);
    }
  };

  const applyProposal = async () => {
    const proposal = agent.proposal;
    if (!proposal) return;
    setApplying(true);
    // La source d'AVANT part avec le jeu de modifications : une fois la
    // composition remplacee, le diff d'une reecriture ne se recalcule plus.
    const previousHtml = flow.state?.html ?? "";
    try {
      await flow.applyProposal(proposal);
      setApplied((list) => [
        {
          id: `${Date.now().toString(36)}-${list.length}`,
          at: Date.now(),
          summary: proposal.summary,
          operations: proposal.operations,
          previousHtml,
        },
        ...list,
      ]);
      agent.setProposal(null);
    } finally {
      setApplying(false);
    }
  };

  const send = async () => {
    const result = await flow.send();
    if (!result) return;
    setSent(true);
    setTimeout(() => setSent(false), 2000);
  };

  if (!flow.status.running) {
    return (
      <div className="flex h-full flex-col">
        <EngineGate status={flow.status} busy={flow.busy} onStart={() => void flow.start()} />
      </div>
    );
  }

  const state = flow.state;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Tooltip>
          <TooltipTrigger render={
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              onClick={pane.toggle}
              aria-label={pane.collapsed ? t("expandPane") : t("collapsePane")}
            >
              <PanelLeft className="size-4" />
            </Button>
          } />
          <TooltipContent>{pane.collapsed ? t("expandPane") : t("collapsePane")}</TooltipContent>
        </Tooltip>
        <span className="truncate text-xs text-muted-foreground">
          {flow.error ? "" : flow.applying ? t("applying") : note || t("running")}
        </span>
        <span className="flex-1" />
        {flow.error ? (
          <span className="truncate text-xs text-destructive">{flow.error}</span>
        ) : null}
        <Tooltip>
          <TooltipTrigger render={
            <Button size="sm" onClick={() => void send()} disabled={flow.busy || !state}>
              {sent ? <Check className="size-4" /> : <Send className="size-4" />}
              {sent ? t("sent") : t("send")}
            </Button>
          } />
          <TooltipContent>{t("sendHint")}</TooltipContent>
        </Tooltip>
        <Button size="sm" variant="ghost" onClick={() => void flow.stop()} disabled={flow.busy}>
          <Square className="size-4" />
          {t("stop")}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div
          className="flex min-w-0 shrink-0 flex-col overflow-hidden border-r"
          style={{ width: pane.width, display: pane.collapsed ? "none" : undefined }}
        >
          <Tabs defaultValue="source" className="flex min-h-0 flex-1 flex-col">
            {/* `overflow-y-hidden` est OBLIGATOIRE avec `overflow-x-auto` :
                des qu'un axe cesse d'etre `visible`, CSS calcule l'autre a
                `auto`, et la bande d'onglets se retrouvait avec une barre de
                defilement VERTICALE pour le pixel de debord de l'indicateur.
                `scrollbar-none` retire aussi la barre horizontale : la bande
                se fait glisser, elle n'a pas besoin d'etre habillee. */}
            <TabsList className="scrollbar-none mx-3 mt-2 w-auto max-w-[calc(100%-1.5rem)] justify-start overflow-x-auto overflow-y-hidden">
              <TabsTrigger value="source" className="shrink-0">{t("tabSource")}</TabsTrigger>
              <TabsTrigger value="params" className="shrink-0">
                {t("tabParams")}
                {state?.variables.length ? (
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    {state.variables.length}
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="cache" className="shrink-0">{t("tabCache")}</TabsTrigger>
              <TabsTrigger value="export" className="shrink-0">{t("tabExport")}</TabsTrigger>
              <TabsTrigger value="agent" className="shrink-0">{t("tabAgent")}</TabsTrigger>
            </TabsList>

            {/* `keepMounted` sur TOUS les panneaux : sans lui, Base UI demonte
                celui qu'on quitte et son etat local part avec — le brouillon de
                l'editeur de code, la position de defilement, le fil de l'agent.
                Passer de « IA » a « Code » effacait donc ce qu'on venait de
                faire. Ils sont masques par `hidden`, que la regle globale de
                index.css rend effective malgre les classes `flex`. */}
            <TabsContent keepMounted value="source" className="flex min-h-0 flex-1 flex-col">
              <SourcePane
                value={state?.html ?? ""}
                busy={flow.busy}
                onApply={(html) => void flow.save({ html })}
              />
            </TabsContent>

            <TabsContent keepMounted value="params" className="min-h-0 flex-1 overflow-y-auto">
              {state ? (
                <>
                  <FlowFormat
                    state={state}
                    onApply={(width, height) => void flow.save({ width, height })}
                  />
                  <div className="border-t">
                    <FlowInspector
                      variables={state.variables}
                      overrides={flow.overrides}
                      onChange={flow.setVariable}
                    />
                  </div>
                </>
              ) : null}
            </TabsContent>

            <TabsContent keepMounted value="cache" className="min-h-0 flex-1 overflow-y-auto">
              <FlowCache running={flow.status.running} />
            </TabsContent>

            <TabsContent keepMounted value="export" className="min-h-0 flex-1 overflow-y-auto">
              <FlowExport
                running={flow.status.running}
                durationFrames={state?.durationFrames ?? 0}
              />
            </TabsContent>

            <TabsContent keepMounted value="agent" className="flex min-h-0 flex-1 flex-col">
              <FlowAgent
                agent={agent}
                frame={flow.frame}
                state={state}
                applied={applied}
                applying={applying}
                onApply={() => void applyProposal()}
                onRevert={(change) => void revertChange(change)}
                frameSpec={frameSpec}
              />
            </TabsContent>
          </Tabs>
        </div>

        {/* The divider. `col-resize` on the whole strip rather than on a hairline:
            a 1 px target is a target nobody hits. Double-click restores the
            default width, which is the gesture everyone tries first. */}
        {pane.collapsed ? null : (
          <div
            role="separator"
            aria-orientation="vertical"
            className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/60"
            onPointerDown={pane.onPointerDown}
            onDoubleClick={pane.reset}
          />
        )}

        {state && state.html ? (
          <FlowPreview
            state={state}
            frame={flow.frame}
            onFrame={flow.setFrame}
            frameUrl={flow.frameUrl}
            revision={flow.revision}
            editorPort={flow.status.editorPort}
            note={setNote}
          />
        ) : (
          <div className="grid flex-1 place-items-center p-8">
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          </div>
        )}

      </div>
    </div>
  );
}
