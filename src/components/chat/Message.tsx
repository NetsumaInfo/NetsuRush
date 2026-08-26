// Un message du fil : bulle utilisateur (à droite, texte brut) ou assistant (à gauche, avec
// raisonnement repliable, cartes d'outils, et corps rendu en Markdown léger maison — zéro dépendance).
// Pendant le tour actif, un indicateur de « réflexion » animé (3 points) marque l'attente avant le texte.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, User, Brain, Copy } from "lucide-react";
import type { UiMessage } from "@/store/chat";
import { useApp } from "@/store";
import { cn } from "@/lib/utils";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
} from "@/components/ui/context-menu";
import { ToolCallCard } from "./ToolCallCard";
import { Markdown } from "./Markdown";

// Indicateur de réflexion : trois points qui ondulent + libellé (statut courant ou « Réflexion »).
function Thinking({ label, fallback }: { label: string; fallback: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-sm text-muted-foreground animate-in fade-in-0">
      <span className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-1.5 rounded-full bg-primary animate-[nrdot_1s_ease-in-out_infinite]" style={{ animationDelay: `${i * 0.16}s` }} />
        ))}
      </span>
      <span>{label || fallback}</span>
    </div>
  );
}

export function Message({ msg, active = false }: { msg: UiMessage; active?: boolean }) {
  const { t } = useTranslation("chat");
  const [showThink, setShowThink] = useState(false);
  const status = useApp((s) => s.chatStatus);
  const isUser = msg.role === "user";
  const runningTool = msg.tools.some((t) => !t.done);
  // « Réflexion » visible tant que le tour est actif et qu'aucun texte final n'est encore arrivé,
  // sauf si un outil tourne déjà (sa carte porte alors l'animation).
  const showThinking = active && !isUser && !msg.content && !runningTool;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className={cn("flex gap-2.5 animate-in fade-in-0 slide-in-from-bottom-1 duration-200", isUser && "flex-row-reverse")} />}>
      <div className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md transition-shadow",
        isUser ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground",
        active && !isUser && "ring-2 ring-primary/40 animate-pulse")}>
        {isUser ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
      </div>
      <div className={cn("min-w-0 flex-1 space-y-2", isUser && "flex flex-col items-end")}>
        {msg.thinking && (
          <div className="w-full">
            <button type="button" onClick={() => setShowThink((s) => !s)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              <Brain className={cn("size-3", active && !msg.content && "animate-pulse text-primary")} /> {showThink ? t("message.hideReasoning") : t("message.reasoning")}
            </button>
            {showThink && <div className="mt-1 select-text whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2 text-xs italic text-muted-foreground">{msg.thinking}</div>}
          </div>
        )}
        {msg.tools.length > 0 && (
          <div className="w-full">{msg.tools.map((t) => <ToolCallCard key={t.id} tool={t} />)}</div>
        )}
        {showThinking && <Thinking label={status} fallback={t("message.thinking")} />}
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
          <ContextMenuItem onClick={() => setShowThink((s) => !s)}>
            <Brain /> {showThink ? t("message.hideReasoning") : t("message.showReasoning")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
