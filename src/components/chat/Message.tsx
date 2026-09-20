// Un message du fil : bulle utilisateur (à droite, texte brut) ou assistant (à gauche, précédé de la
// TRACE de son tour — raisonnement et outils dans l'ordre, cf. AgentTrace — puis du corps rendu en
// Markdown léger maison, zéro dépendance).
import { useTranslation } from "react-i18next";
import { Bot, User, Copy, Brain } from "lucide-react";
import type { UiMessage } from "@/store/chat";
import { cn } from "@/lib/utils";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
} from "@/components/ui/context-menu";
import { AgentTrace } from "./AgentTrace";
import { Markdown } from "./Markdown";

export function Message({ msg, active = false, status }: {
  msg: UiMessage; active?: boolean; status?: string;
}) {
  const { t } = useTranslation("chat");
  const isUser = msg.role === "user";

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className={cn("flex gap-2.5 animate-in fade-in-0 slide-in-from-bottom-1 duration-200", isUser && "flex-row-reverse")} />}>
      <div className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md transition-shadow",
        isUser ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground",
        active && !isUser && "ring-2 ring-primary/40 animate-pulse")}>
        {isUser ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
      </div>
      <div className={cn("min-w-0 flex-1 space-y-2", isUser && "flex flex-col items-end")}>
        {!isUser && <AgentTrace msg={msg} active={active} status={status} />}
        {msg.content && (
          <div className={cn("max-w-[85%] select-text rounded-lg px-3 py-2 text-sm leading-relaxed",
            isUser ? "whitespace-pre-wrap bg-primary/15 text-foreground" : "bg-card text-foreground")}>
            {isUser ? msg.content : <Markdown text={msg.content} />}
          </div>
        )}
      </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(msg.content)} disabled={!msg.content}>
          <Copy /> {t("message.copyText")}
        </ContextMenuItem>
        {msg.thinking && (
          <ContextMenuItem onClick={() => navigator.clipboard.writeText(msg.thinking)}>
            <Brain /> {t("message.copyReasoning")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
