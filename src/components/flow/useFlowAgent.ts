// Le tour d'agent du panneau NetsuFlow.
//
// Il tenait ses messages dans sa propre forme — deux champs, `role` et
// `content` — et n'affichait donc qu'un pavé de texte : ni raisonnement, ni
// outils, ni chronologie. NetsuPilot avait déjà tout cela (`AgentTrace`), et il
// ne lui manquait que des données à la bonne forme. On construit donc ici le
// même `UiMessage` que le store du chat, et les deux fenêtres partagent le même
// rendu au lieu d'en avoir chacune un.
import { useCallback, useEffect, useRef, useState } from "react";

import { nr } from "@/lib/bridge";
import type { ChatEvent, ChatImage, ChatMessage, ChatProvider, ChatThinking } from "@/lib/bridge";
import type { UiMessage } from "@/store/chat";
import { systemPromptFor } from "@/lib/agentPrompts";
import { errorText } from "@/lib/errorText";

/// A change the agent proposes. It has been validated by `flow_propose`
/// against the composition, so every operation here names something that
/// exists — but nothing has been applied.
export type FlowOperation =
  | { type: "variable.set"; variableId: string; value: unknown; previous?: unknown; reason?: string }
  | { type: "format.set"; width: number; height: number; reason?: string }
  | { type: "source.replace"; source: string; reason?: string };

export type FlowProposal = {
  summary: string;
  operations: FlowOperation[];
  previewFrames: number[];
  baseRevision: string;
};

/// A context chip: what the message carries besides its text.
///
/// The composer suggests the current frame rather than silently attaching the
/// whole project, which is the distinction `12-selection-inspector-and-ai-editing`
/// draws between an attachment and a context dump.
export type FlowAttachment = { kind: "frame"; label: string; frame: number };

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const emptyMessage = (role: "user" | "assistant", content: string): UiMessage => ({
  id: uid(), role, content, thinking: "", tools: [], steps: [],
  ...(role === "assistant" ? { startedAt: Date.now() } : {}),
});

export function useFlowAgent({ provider, agent, model, thinking, frameSpec }: {
  provider: ChatProvider;
  agent?: string;
  model?: string;
  thinking?: ChatThinking;
  /// Le cahier de design de l'utilisateur (`frame.md`), joint au prompt.
  frameSpec?: string | null;
}) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [proposal, setProposal] = useState<FlowProposal | null>(null);
  const [error, setError] = useState("");
  /// Le libellé « ce qu'il fait en ce moment », tenu ICI et pas dans le store du
  /// chat : ce panneau a son propre tour, et lire le statut de NetsuPilot lui
  /// faisait afficher la dernière phrase d'une conversation qui n'est pas la
  /// sienne — ou rien du tout.
  const [status, setStatus] = useState("");
  const runId = useRef<string | null>(null);

  useEffect(() => {
    const off = nr.chat?.onEvent(({ runId: id, ev }) => {
      if (id !== runId.current) return;
      applyEvent(ev);
    });
    return () => { off?.(); };
    // `applyEvent` is stable enough to leave out: it only closes over setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /// Modifie le dernier message assistant — celui du tour en cours.
  const patch = (fn: (m: UiMessage) => UiMessage) => {
    setMessages((list) => {
      let idx = -1;
      for (let i = list.length - 1; i >= 0; i--) if (list[i].role === "assistant") { idx = i; break; }
      if (idx < 0) return list;
      const next = list.slice();
      next[idx] = fn(next[idx]);
      return next;
    });
  };

  const applyEvent = (ev: ChatEvent) => {
    switch (ev.type) {
      case "text":
        patch((m) => ({ ...m, content: m.content + (ev.delta || "") }));
        return;

      case "thinking":
        // Les fragments s'agrègent dans l'étape de raisonnement EN COURS. Une
        // nouvelle étape ne s'ouvre qu'après un outil : c'est ce qui distingue
        // « il a réfléchi, agi, puis re-réfléchi » d'un pavé unique.
        patch((m) => {
          const delta = ev.delta || "";
          const steps = m.steps.slice();
          const last = steps[steps.length - 1];
          if (last?.kind === "reasoning") steps[steps.length - 1] = { kind: "reasoning", text: last.text + delta };
          else steps.push({ kind: "reasoning", text: delta });
          return { ...m, thinking: m.thinking + delta, steps };
        });
        return;

      case "tool_use":
        patch((m) => {
          const id = ev.id || uid();
          return {
            ...m,
            tools: [...m.tools, { id, name: ev.name || "", input: ev.input, done: false, startedAt: Date.now() }],
            steps: [...m.steps, { kind: "tool", id }],
          };
        });
        return;

      case "tool_result": {
        patch((m) => ({
          ...m,
          tools: m.tools.map((tool) => (tool.id === ev.id
            ? { ...tool, ok: ev.ok, result: ev.content, done: true, endedAt: Date.now() }
            : tool)),
        }));
        // Le seul résultat qu'on intercepte : le reste est du contexte que le
        // modèle a demandé et dont il se sert lui-même.
        const content = ev.content as { proposal?: FlowProposal } | undefined;
        if (content?.proposal) setProposal(content.proposal);
        return;
      }

      case "status":
        setStatus(ev.label || "");
        return;

      case "error":
        setError(ev.message ?? "");
        return;

      case "done":
        patch((m) => ({ ...m, endedAt: Date.now() }));
        setRunning(false);
        setStatus("");
        runId.current = null;
        return;

      default:
        return;
    }
  };

  const send = useCallback(async (text: string, attachments: FlowAttachment[], images?: ChatImage[]) => {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    setError("");
    setStatus("");
    setProposal(null);

    // Attachments become a line of context rather than a hidden payload: the
    // user can see exactly what the model was told.
    const context = attachments.map((a) => `[${a.label}]`).join(" ");
    const content = context ? `${context}\n${trimmed}` : trimmed;

    const history: ChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
    // Les images ne partent qu'avec le message COURANT : les renvoyer a chaque
    // tour multiplierait le cout d'une conversation par le nombre d'echanges.
    const wire: ChatMessage[] = [
      ...history,
      { role: "user", content, ...(images && images.length ? { images } : {}) },
    ];
    setMessages((list) => [...list, emptyMessage("user", content), emptyMessage("assistant", "")]);
    setRunning(true);

    const id = uid();
    runId.current = id;
    try {
      await nr.chat?.send({
        runId: id,
        provider,
        agent,
        model,
        thinking,
        messages: wire,
        // The surface picks the tool set AND the prompt. Sending one without
        // the other describes capabilities the model has not been given.
        surface: "flow",
        system: systemPromptFor("flow", frameSpec),
      });
    } catch (e) {
      setError(errorText(e));
      setRunning(false);
      setStatus("");
      runId.current = null;
    }
  }, [messages, provider, agent, model, thinking, frameSpec, running]);

  const cancel = useCallback(() => {
    if (runId.current) void nr.chat?.cancel(runId.current);
    setRunning(false);
    setStatus("");
    runId.current = null;
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    setProposal(null);
    setError("");
    setStatus("");
  }, []);

  /// Remplace le fil courant. Passer d'une discussion a l'autre annule le tour
  /// en vol : ses evenements portent l'identifiant de l'ancien tour et se
  /// deverseraient dans la conversation qu'on vient d'ouvrir.
  const loadMessages = useCallback((next: UiMessage[]) => {
    if (runId.current) void nr.chat?.cancel(runId.current);
    runId.current = null;
    setRunning(false);
    setStatus("");
    setError("");
    setProposal(null);
    setMessages(next);
  }, []);

  return {
    messages, running, status, proposal, error,
    send, cancel, clear, setProposal, loadMessages,
  };
}
