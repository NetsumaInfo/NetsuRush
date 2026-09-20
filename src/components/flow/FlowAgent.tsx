import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Image as ImageIcon, Paperclip, Plus, Settings2, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { EngineMenu } from "@/components/chat/EngineMenu";
import { ChatSettings } from "@/components/chat/ChatSettings";
// Le meme rendu que NetsuPilot : trace du tour (raisonnement + outils, dans
// l'ordre) puis reponse en Markdown. Cette fenetre affichait un pave de texte
// brut, donc rien de ce que l'agent faisait n'etait visible.
import { Message } from "@/components/chat/Message";
import { FlowChanges, type AppliedChange } from "@/components/flow/FlowChanges";
import { useFlowConversations } from "@/components/flow/useFlowConversations";
import { FlowFrameSpec } from "@/components/flow/FlowFrameSpec";
import { useFlowAttachments } from "@/components/flow/useFlowAttachments";
import type { useFrameSpec } from "@/components/flow/useFrameSpec";
import type { FlowState } from "@/lib/bridge";
import type { FlowAttachment, useFlowAgent } from "@/components/flow/useFlowAgent";

/// Le fil de discussion seul.
///
/// La proposition et l'historique s'affichent ICI, sous le fil : c'est la
/// conversation qui les produit. Ils ont eu une colonne a droite de l'apercu,
/// ce qui obligeait a regarder deux endroits pour suivre une seule chose et
/// coutait 360 px a l'apercu — la largeur dont il a le plus besoin.
export function FlowAgent({ agent, frame, state, applied, applying, onApply, onRevert, frameSpec }: {
  agent: ReturnType<typeof useFlowAgent>;
  frame: number;
  state: FlowState | null;
  applied: AppliedChange[];
  applying: boolean;
  onApply: () => void;
  onRevert: (change: AppliedChange) => void;
  /// Le cahier de design joint aux demandes (`frame.md`).
  frameSpec: ReturnType<typeof useFrameSpec>;
}) {
  const { t } = useTranslation("flow");
  const conversations = useFlowConversations(agent.loadMessages);
  // Chaque tour termine est recopie dans la discussion active : sans cela,
  // seul un changement de discussion sauvegarderait, et fermer l'application
  // perdrait le dernier echange.
  const wasRunning = useRef(agent.running);
  useEffect(() => {
    if (wasRunning.current && !agent.running) void conversations.remember(agent.messages);
    wasRunning.current = agent.running;
  }, [agent.running, agent.messages, conversations]);

  const attached = useFlowAttachments();
  const filePicker = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [withFrame, setWithFrame] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const attachments: FlowAttachment[] = withFrame
    ? [{ kind: "frame", label: `${t("frameChip")} ${frame}`, frame }]
    : [];

  const submit = () => {
    // Le texte des fichiers rejoint le corps du message, les images voyagent a
    // cote : ce sont deux canaux differents cote API.
    const { images, text } = attached.payload();
    void agent.send(draft + text, attachments, images);
    setDraft("");
    attached.clear();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {settingsOpen ? (
        <ChatSettings onClose={() => setSettingsOpen(false)} />
      ) : (
      <>
      {/* Les discussions. Une composition se travaille par essais ; melanges
          dans un fil unique, ils donnent au modele un contexte qui contredit
          la demande en cours. `scrollbar-none` : la bande se fait glisser. */}
      <div className="scrollbar-none flex shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-b px-2 py-1.5">
        {/* Le fil en cours mais pas encore ecrit : il n'a pas d'identifiant tant
            qu'aucun tour n'est termine, donc il n'apparait pas dans la liste du
            disque et il lui faut sa propre pastille. */}
        {conversations.activeId === null ? (
          <span className="shrink-0 rounded-sm bg-primary/15 px-2 py-0.5 text-[11px] font-medium">
            {t("conversationNew")}
          </span>
        ) : null}
        {conversations.list.map((conversation) => (
          <div key={conversation.id} className="group/conv flex shrink-0 items-center">
            <Tooltip>
              <TooltipTrigger render={
                <button
                  type="button"
                  onClick={() => void conversations.select(conversation.id, agent.messages)}
                  className={cn(
                    "max-w-40 truncate rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors",
                    conversation.id === conversations.activeId
                      ? "bg-primary/15 text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                />
              }>
                {conversation.title}
              </TooltipTrigger>
              <TooltipContent>{conversation.title}</TooltipContent>
            </Tooltip>
            <button
              type="button"
              aria-label={t("closeConversation")}
              onClick={() => void conversations.remove(conversation.id)}
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/conv:opacity-100 focus-visible:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <Tooltip>
          <TooltipTrigger render={
            <Button
              size="icon"
              variant="ghost"
              className="size-6 shrink-0"
              aria-label={t("newConversation")}
              onClick={() => void conversations.create(agent.messages)}
            >
              <Plus className="size-3.5" />
            </Button>
          } />
          <TooltipContent>{t("newConversation")}</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {agent.messages.map((message, index) => (
          <Message
            key={message.id}
            msg={message}
            status={agent.status}
            active={agent.running
              && index === agent.messages.length - 1
              && message.role === "assistant"}
          />
        ))}
        {state ? (
          <FlowChanges
            state={state}
            proposal={agent.proposal}
            applied={applied}
            applying={applying}
            onApply={onApply}
            onReject={() => agent.setProposal(null)}
            onRevert={onRevert}
          />
        ) : null}
        {agent.error ? <p className="text-xs text-destructive">{agent.error}</p> : null}
      </div>
      </>
      )}

      <div className="flex flex-col gap-2 border-t p-3">
        {/* Le cahier de design, juste au-dessus de la saisie : il fait partie de
            la demande, pas des reglages — c'est ce qui separe « fais-moi une
            animation » de « fais-moi une animation DANS CETTE CHARTE ». */}
        <FlowFrameSpec
          spec={frameSpec.spec}
          error={frameSpec.error}
          onLoad={(file) => void frameSpec.load(file)}
          onClear={frameSpec.clear}
        />

        {/* Les pieces jointes du message : images vues par le modele, fichiers
            texte inseres dans le corps. Elles partent avec l'envoi et
            disparaissent ensuite — ce ne sont pas des reglages. */}
        {attached.files.length ? (
          <div className="flex flex-wrap gap-1">
            {attached.files.map((file) => (
              <span key={file.name} className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px]">
                {file.kind === "image"
                  ? <ImageIcon className="size-3 shrink-0 opacity-60" />
                  : <FileText className="size-3 shrink-0 opacity-60" />}
                <span className="max-w-32 truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={t("removeAttachment")}
                  onClick={() => attached.remove(file.name)}
                  className="rounded p-0.5 hover:text-destructive"
                >
                  <X className="size-2.5" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {attached.error ? (
          <p className="text-[11px] text-destructive">{attached.error}</p>
        ) : null}
        <div className="flex items-center gap-1">
          <Badge
            variant={withFrame ? "default" : "outline"}
            className="cursor-pointer text-[10px]"
            onClick={() => setWithFrame((value) => !value)}
          >
            {t("frameChip")} {frame}
          </Badge>
          <Tooltip>
            <TooltipTrigger render={
              <Button
                size="icon"
                variant="ghost"
                className="size-6"
                aria-label={t("attach")}
                onClick={() => filePicker.current?.click()}
              >
                <Paperclip className="size-3.5" />
              </Button>
            } />
            <TooltipContent>{t("attachHint")}</TooltipContent>
          </Tooltip>
          <input
            ref={filePicker}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif,.md,.txt,.json,.csv,.yaml,.yml,.html,.css,.js,.ts,.svg"
            className="hidden"
            onChange={(event) => {
              const picked = Array.from(event.target.files ?? []);
              if (picked.length) void attached.add(picked);
              // Remis a zero pour que rejoindre LE MEME fichier redeclenche
              // l'evenement apres l'avoir retire.
              event.target.value = "";
            }}
          />
          <span className="flex-1" />
          {agent.messages.length ? (
            <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={agent.clear}>
              {t("clearChat")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-xs"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <Settings2 className="size-3" />
          </Button>
        </div>
        {/* The engine picker, not a second one: the same store, the same keys.
            Changing model should not mean leaving the composition. */}
        <EngineMenu showDuplicate={false} />
        <Textarea
          className="min-h-16 resize-none text-xs"
          value={draft}
          placeholder={t("agentPlaceholder")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex gap-2">
          <Button size="sm" className="h-7" onClick={submit} disabled={agent.running || !draft.trim()}>
            {agent.running ? <Spinner className="size-3.5" /> : <Sparkles className="size-3.5" />}
            {t("ask")}
          </Button>
          {agent.running ? (
            <Button size="sm" variant="ghost" className="h-7" onClick={agent.cancel}>
              {t("cancel")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
